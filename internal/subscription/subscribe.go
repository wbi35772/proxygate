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
	path := settings.SubscriptionPath
	if path == "" {
		path = "/pgws"
	}
	links := make([]vlessNode, 0, len(statuses))
	for _, status := range statuses {
		if status.State != "ready" || status.ExitIP == "" {
			continue
		}
		links = append(links, vlessNode{
			name: nodeName(status),
			uuid: slotUUID(settings.SubscriptionTokenValue(), status.SlotID),
			host: host,
			port: port,
			tls:  tls,
			path: path,
		})
	}

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Profile-Update-Interval", "6")
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

type vlessNode struct {
	name string
	uuid string
	host string
	port int
	tls  bool
	path string
}

func (n vlessNode) link() string {
	query := url.Values{}
	query.Set("encryption", "none")
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
	return "vless://" + n.uuid + "@" + net.JoinHostPort(n.host, strconv.Itoa(n.port)) + "?" + query.Encode() + "#" + url.PathEscape(n.name)
}

func v2raySubscription(nodes []vlessNode) string {
	if len(nodes) == 0 {
		return ""
	}
	lines := make([]string, 0, len(nodes))
	for _, node := range nodes {
		lines = append(lines, node.link())
	}
	return base64.StdEncoding.EncodeToString([]byte(strings.Join(lines, "\n")))
}

func clashProfile(nodes []vlessNode) string {
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
		builder.WriteString("    type: vless\n")
		builder.WriteString("    server: " + strconv.Quote(node.host) + "\n")
		builder.WriteString("    port: " + strconv.Itoa(node.port) + "\n")
		builder.WriteString("    uuid: " + strconv.Quote(node.uuid) + "\n")
		builder.WriteString("    udp: false\n")
		builder.WriteString("    tls: true\n")
		builder.WriteString("    servername: " + strconv.Quote(node.host) + "\n")
		builder.WriteString("    client-fingerprint: chrome\n")
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
