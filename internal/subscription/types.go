// Package subscription turns allocated matrix slots into VLESS-over-WebSocket
// nodes and publishes v2rayN/Clash subscriptions for them. Instabox terminates
// TLS at its edge, so the WebSocket listener is plain HTTP and the subscription
// links point at the public HTTPS endpoint.
package subscription

import (
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/ExpTechTW/proxygate/internal/config"
	"github.com/ExpTechTW/proxygate/internal/matrix"
)

type Server struct {
	config *config.Store
	matrix *matrix.Manager
	logger *log.Logger

	mu    sync.RWMutex
	slots map[string]int

	httpServer *http.Server
	listener   net.Listener
}

func New(configStore *config.Store, matrixManager *matrix.Manager, logger *log.Logger) *Server {
	server := &Server{
		config: configStore,
		matrix: matrixManager,
		logger: logger,
	}
	server.rebuildSlots()
	return server
}

func (s *Server) rebuildSlots() {
	settings := s.config.Get().Matrix
	token := settings.SubscriptionTokenValue()
	slots := make(map[string]int, settings.Slots)
	for id := 1; id <= settings.Slots; id++ {
		slots[slotUUID(token, id)] = id
	}
	s.mu.Lock()
	s.slots = slots
	s.mu.Unlock()
}

func (s *Server) slotID(uuid string) (int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, exists := s.slots[uuid]
	return id, exists
}
