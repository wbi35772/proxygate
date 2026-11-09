package subscription

import (
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ExpTechTW/proxygate/internal/matrix"
)

func (s *Server) handleSubscription(writer http.ResponseWriter, r *http.Request) {
	settings := s.config.Get().Matrix
	rest := strings.TrimPrefix(r.URL.Path, "/sub/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	token := parts[0]
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(settings.SubscriptionTokenValue())) != 1 {
		http.NotFound(writer, r)
		return
	}
	format := ""
	if len(parts) > 1 {
		format = strings.ToLower(parts[1])
	}
	if format == "" {
		format = detectFormat(r.UserAgent())
	}

	statuses, _ := s.matrix.Status()
	host, port, tls := s.publicEndpoint(r)
	trojanPath := settings.SubscriptionTrojanPath
	if trojanPath == "" {
		trojanPath = "/pgtrojan"
	}
	links := make([]trojanNode, 0, len(statuses))
	for _, status := range statuses {
		if status.State != "ready" || status.ExitIP == "" {
			continue
		}
		links = append(links, trojanNode{
			name:     nodeName(status),
			password: slotUUID(settings.SubscriptionTokenValue(), status.SlotID),
			host:     host,
			port:     port,
			tls:      tls,
			path:     trojanPath,
		})
	}
	if len(links) > 0 {
		s.rememberNodes(links)
	} else if cached, ok := s.lastGoodNodes(); ok {
		links = cached
	}

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Profile-Update-Interval", "6")
	writer.Header().Set("X-ProxyGate-Nodes", strconv.Itoa(len(links)))
	if len(links) == 0 {
		writer.Header().Set("Retry-After", "60")
		http.Error(writer, "no ready slots yet", http.StatusServiceUnavailable)
		return
	}
	switch format {
	case "clash", "mihomo", "yaml", "clash.yaml":
		writer.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		_, _ = writer.Write([]byte(clashProfile(links)))
	case "v2ray", "v2rayn", "base64", "txt":
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = writer.Write([]byte(v2raySubscription(links)))
	default:
		http.NotFound(writer, r)
	}
}

func detectFormat(agent string) string {
	agent = strings.ToLower(agent)
	for _, marker := range []string{"clash", "mihomo", "stash", "flclash"} {
		if strings.Contains(agent, marker) {
			return "clash"
		}
	}
	return "v2ray"
}

func (s *Server) publicEndpoint(r *http.Request) (string, int, bool) {
	settings := s.config.Get().Matrix
	host := strings.TrimSpace(settings.PublicHost)
	if host == "" {
		host = r.Host
		if parsed, _, err := net.SplitHostPort(host); err == nil {
			host = parsed
		}
	}
	host = strings.Trim(host, "[]")
	return host, 443, true
}

func nodeName(status matrix.SlotStatus) string {
	country := status.CountryShort
	if country == "" {
		country = "XX"
	}
	organization := status.ASNOrg
	if index := strings.Index(organization, " - "); index >= 0 {
		organization = organization[:index]
	}
	organization = strings.Map(func(symbol rune) rune {
		switch {
		case symbol >= 'a' && symbol <= 'z', symbol >= 'A' && symbol <= 'Z', symbol >= '0' && symbol <= '9':
			return symbol
		default:
			return -1
		}
	}, organization)
	if organization == "" {
		organization = strings.TrimPrefix(status.ASN, "AS")
	}
	if organization == "" {
		organization = "node"
	}
	return fmt.Sprintf("pg-%02d-%s-%s", status.SlotID, country, organization)
}

type trojanNode struct {
	name     string
	password string
	host     string
	port     int
	tls      bool
	path     string
}

func (n trojanNode) link() string {
	query := url.Values{}
	query.Set("type", "ws")
	query.Set("host", n.host)
	query.Set("path", n.path)
	if n.tls {
		query.Set("security", "tls")
		query.Set("sni", n.host)
		query.Set("fp", "chrome")
	} else {
		query.Set("security", "none")
	}
	return "trojan://" + url.QueryEscape(n.password) + "@" + net.JoinHostPort(n.host, strconv.Itoa(n.port)) + "?" + query.Encode() + "#" + url.PathEscape(n.name)
}

func v2raySubscription(nodes []trojanNode) string {
	if len(nodes) == 0 {
		return ""
	}
	lines := make([]string, 0, len(nodes))
	for _, node := range nodes {
		lines = append(lines, node.link())
	}
	return base64.StdEncoding.EncodeToString([]byte(strings.Join(lines, "\n")))
}

// rememberNodes keeps the last non-empty node set so a subscription request
// during a pool rebuild (container restart, slot re-allocation) still returns
// a usable profile instead of an empty one. Slot credentials are derived from
// the token and slot id, so cached entries stay valid across refreshes.
func (s *Server) rememberNodes(nodes []trojanNode) {
	if len(nodes) == 0 {
		return
	}
	snapshot := append([]trojanNode(nil), nodes...)
	s.cacheMu.Lock()
	s.cachedNodes = snapshot
	s.cachedAt = time.Now()
	s.cacheMu.Unlock()
}

func (s *Server) lastGoodNodes() ([]trojanNode, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	if len(s.cachedNodes) == 0 {
		return nil, false
	}
	return append([]trojanNode(nil), s.cachedNodes...), true
}

func clashProfile(nodes []trojanNode) string {
	var builder strings.Builder
	builder.WriteString("mixed-port: 7890\n")
	builder.WriteString("allow-lan: false\n")
	builder.WriteString("mode: rule\n")
	builder.WriteString("log-level: info\n")
	builder.WriteString("ipv6: false\n")
	builder.WriteString("proxies:\n")
	if len(nodes) == 0 {
		builder.WriteString("  - name: \"direct\"\n    type: direct\n")
	}
	for _, node := range nodes {
		builder.WriteString("  - name: " + strconv.Quote(node.name) + "\n")
		builder.WriteString("    type: trojan\n")
		builder.WriteString("    server: " + strconv.Quote(node.host) + "\n")
		builder.WriteString("    port: " + strconv.Itoa(node.port) + "\n")
		builder.WriteString("    password: " + strconv.Quote(node.password) + "\n")
		builder.WriteString("    udp: true\n")
		if node.tls {
			builder.WriteString("    sni: " + strconv.Quote(node.host) + "\n")
			builder.WriteString("    skip-cert-verify: false\n")
			builder.WriteString("    client-fingerprint: chrome\n")
		}
		builder.WriteString("    network: ws\n")
		builder.WriteString("    ws-opts:\n")
		builder.WriteString("      path: " + strconv.Quote(node.path) + "\n")
		builder.WriteString("      headers:\n")
		builder.WriteString("        Host: " + strconv.Quote(node.host) + "\n")
	}
	builder.WriteString("proxy-groups:\n")
	builder.WriteString("  - name: ProxyGate\n")
	builder.WriteString("    type: select\n")
	builder.WriteString("    proxies:\n")
	if len(nodes) == 0 {
		builder.WriteString("      - \"direct\"\n")
	}
	for _, node := range nodes {
		builder.WriteString("      - " + strconv.Quote(node.name) + "\n")
	}
	builder.WriteString("rules:\n")
	builder.WriteString("  - MATCH,ProxyGate\n")
	return builder.String()
}
