package server

import (
	"net"
	"net/url"
	"strings"

	"github.com/gofiber/fiber/v3"

	"github.com/ExpTechTW/proxygate/internal/config"
)

type subscriptionInfo struct {
	Enabled       bool           `json:"enabled"`
	V2RayURL      string         `json:"v2rayUrl"`
	ClashURL      string         `json:"clashUrl"`
	AutoURL       string         `json:"autoUrl"`
	PublicHost    string         `json:"publicHost"`
	Token         string         `json:"token"`
	WebSocketPath string         `json:"websocketPath"`
	TrojanPath    string         `json:"trojanPath"`
	Protocol      string         `json:"protocol"`
	UDP           bool           `json:"udp"`
	Slots         map[string]int `json:"slots"`
}

func (s *Server) subscription(c fiber.Ctx) error {
	current := s.config.Get()
	settings := current.Matrix
	slots := map[string]int{"total": 0, "ready": 0, "switching": 0, "error": 0}
	statuses, _ := s.matrix.Status()
	for _, status := range statuses {
		slots["total"]++
		switch status.State {
		case "ready":
			slots["ready"]++
		case "switching":
			slots["switching"]++
		default:
			slots["error"]++
		}
	}

	token := settings.SubscriptionTokenValue()
	host := subscriptionPublicHost(c, settings, current.Web.ListenAddress)
	websocketPath := settings.SubscriptionPath
	if websocketPath == "" {
		websocketPath = "/pgws"
	}
	trojanPath := settings.SubscriptionTrojanPath
	if trojanPath == "" {
		trojanPath = "/pgtrojan"
	}

	info := subscriptionInfo{
		Enabled:       strings.TrimSpace(settings.SubscriptionListen) != "",
		PublicHost:    host,
		Token:         token,
		WebSocketPath: websocketPath,
		TrojanPath:    trojanPath,
		Protocol:      "trojan-ws",
		UDP:           true,
		Slots:         slots,
	}
	if host != "" && token != "" {
		base := "https://" + host + "/sub/" + url.PathEscape(token)
		info.V2RayURL = base + "/v2ray"
		info.ClashURL = base + "/clash"
		info.AutoURL = base
	}
	return writeJSON(c, fiber.StatusOK, info)
}

// subscriptionPublicHost resolves the host clients use to fetch the
// subscription. The configured public host wins; otherwise the panel request
// host is adapted to the subscription listener (including the Instabox
// "PORT-name" edge style where the port is part of the hostname).
func subscriptionPublicHost(c fiber.Ctx, settings config.Matrix, webListen string) string {
	if host := strings.TrimSpace(settings.PublicHost); host != "" {
		return strings.Trim(host, "[]")
	}
	requestHost := strings.TrimSpace(c.Get(fiber.HeaderHost))
	if host, _, err := net.SplitHostPort(requestHost); err == nil {
		requestHost = host
	}
	requestHost = strings.Trim(requestHost, "[]")
	subPort := listenPort(settings.SubscriptionListen)
	webPort := listenPort(webListen)
	if requestHost == "" || subPort == "" {
		return ""
	}
	if webPort != "" {
		if parts := strings.SplitN(requestHost, "-", 2); len(parts) == 2 && parts[0] == webPort {
			return subPort + "-" + parts[1]
		}
	}
	if strings.Contains(requestHost, ":") {
		return requestHost
	}
	return net.JoinHostPort(requestHost, subPort)
}

func listenPort(address string) string {
	if _, port, err := net.SplitHostPort(address); err == nil {
		return port
	}
	if strings.HasPrefix(address, ":") {
		return strings.TrimPrefix(address, ":")
	}
	return ""
}
