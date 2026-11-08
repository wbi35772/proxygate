package matrix

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ExpTechTW/proxygate/internal/config"
	"github.com/ExpTechTW/proxygate/internal/model"
	"github.com/ExpTechTW/proxygate/internal/socks5"
	"github.com/ExpTechTW/proxygate/internal/store"
	"github.com/ExpTechTW/proxygate/internal/vpn"
)

const (
	StateAllocated  = "allocated"
	StateSwitching  = "switching"
	StateReady      = "ready"
	StateError      = "error"
	ModeSticky      = "sticky"
	ModeRotating    = "rotating"
	switchDeadline  = 45 * time.Second
	switchRetryWait = 15 * time.Second
)

type Slot struct {
	id       int
	username string
	password string
	address  string
	ctx      context.Context
	cancel   context.CancelFunc
	manager  *Manager
	logger   *log.Logger
	listener net.Listener

	mu         sync.RWMutex
	mode       string
	protocol   string
	country    string
	node       model.Node
	exitIP     string
	tunnel     *vpn.Tunnel
	state      string
	lastErr    string
	lastSwitch time.Time
	ready      chan struct{}

	switchMu sync.Mutex
	closed   bool
}

func newSlot(parent context.Context, manager *Manager, id int) *Slot {
	ctx, cancel := context.WithCancel(parent)
	settings := manager.config.Get()
	return &Slot{
		id:       id,
		username: settings.Matrix.Username(id),
		password: settings.Matrix.Password,
		address:  settings.Matrix.SlotAddress(id),
		ctx:      ctx,
		cancel:   cancel,
		manager:  manager,
		logger:   manager.logger,
		mode:     ModeSticky,
		state:    StateAllocated,
		ready:    make(chan struct{}),
	}
}

func (s *Slot) Start() error {
	listener, err := net.Listen("tcp", s.address)
	if err != nil {
		return fmt.Errorf("listen matrix slot %d on %s: %w", s.id, s.address, err)
	}
	s.listener = listener
	settings := s.manager.config.Get().SOCKS5
	settings.Username = s.username
	settings.Password = s.password
	server := socks5.NewWithSettings(s, s.logger, settings)
	go func() {
		if err := server.Serve(s.ctx, listener); err != nil && !errors.Is(err, context.Canceled) && s.ctx.Err() == nil {
			s.logger.Printf("[matrix] slot=%d SOCKS5 listener stopped: %v", s.id, err)
		}
	}()
	s.logger.Printf("[matrix] slot=%d listening on %s as %s", s.id, s.address, s.username)
	return nil
}

func (s *Slot) ID() int         { return s.id }
func (s *Slot) Username() string { return s.username }
func (s *Slot) Password() string { return s.password }
func (s *Slot) Address() string  { return s.address }

func (s *Slot) Configure(country, protocol, mode string) {
	s.mu.Lock()
	s.country = strings.ToUpper(country)
	s.protocol = protocol
	s.mode = mode
	s.mu.Unlock()
	s.RequestSwitch("configure", true)
}

func (s *Slot) RequestSwitch(reason string, allowSameIP bool) bool {
	if !s.switchMu.TryLock() {
		return false
	}
	go func() {
		defer s.switchMu.Unlock()
		s.switchSession(reason, allowSameIP)
	}()
	return true
}

func (s *Slot) Rotate() bool {
	return s.RequestSwitch("api rotate", false)
}

func (s *Slot) switchSession(reason string, allowSameIP bool) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	previous := s.node
	previousExit := s.exitIP
	oldTunnel := s.tunnel
	targetCountry := s.country
	protocol := s.protocol
	mode := s.mode
	s.tunnel = nil
	s.node = model.Node{}
	s.exitIP = ""
	s.state = StateSwitching
	s.lastErr = ""
	s.ready = make(chan struct{})
	s.mu.Unlock()

	if oldTunnel != nil {
		_ = oldTunnel.Close()
	}
	if previous.IP != "" {
		s.manager.releaseNodeIP(previous.IP, s.id)
	}
	if previousExit != "" {
		s.manager.releaseExitIP(previousExit, s.id)
	}

	settings := s.manager.config.Get()
	candidates := s.candidates(previous, targetCountry, protocol, mode, allowSameIP, settings)
	if len(candidates) == 0 {
		s.fail(fmt.Errorf("no pool candidate for country=%s protocol=%s (%s)", targetCountry, protocol, reason))
		return
	}
	var lastErr error
	for _, candidate := range candidates {
		if s.ctx.Err() != nil {
			return
		}
		if !s.manager.reserveNodeIP(candidate.IP, s.id) {
			continue
		}
		var tunnel *vpn.Tunnel
		tunnel = vpn.NewTunnel(s.ctx, s.manager.config, s.logger, s.manager.drivers, func(ip string) {
			s.handleDown(tunnel, ip)
		})
		connectCtx, cancel := context.WithTimeout(s.ctx, switchDeadline)
		err := tunnel.Connect(connectCtx, candidate, protocol)
		cancel()
		if err != nil {
			s.manager.releaseNodeIP(candidate.IP, s.id)
			_ = tunnel.Close()
			_ = s.manager.database.MarkPoolFailure(s.ctx, candidate.IP, protocolForFailure(candidate, protocol), err.Error())
			lastErr = fmt.Errorf("node %s (%s/%s): %w", candidate.IP, candidate.CountryShort, candidate.ASNOrg, err)
			s.logger.Printf("[matrix] slot=%d candidate failed %v", s.id, lastErr)
			continue
		}
		probeCtx, probeCancel := context.WithTimeout(s.ctx, 12*time.Second)
		exitIP := probeExitIP(probeCtx, tunnel)
		probeCancel()
		if exitIP == "" {
			exitIP = candidate.IP
		}
		if !s.manager.reserveExitIP(exitIP, s.id) {
			s.manager.releaseNodeIP(candidate.IP, s.id)
			_ = tunnel.Close()
			lastErr = fmt.Errorf("node %s exits through IP %s already used by another slot", candidate.IP, exitIP)
			s.logger.Printf("[matrix] slot=%d candidate skipped: %v", s.id, lastErr)
			continue
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			s.manager.releaseNodeIP(candidate.IP, s.id)
			s.manager.releaseExitIP(exitIP, s.id)
			_ = tunnel.Close()
			return
		}
		s.tunnel = tunnel
		s.node = candidate
		s.exitIP = exitIP
		s.state = StateReady
		s.lastSwitch = time.Now()
		close(s.ready)
		s.mu.Unlock()
		s.logger.Printf("[matrix] slot=%d ready node=%s exit=%s country=%s asn=%s residential=%t reason=%s", s.id, candidate.IP, exitIP, candidate.CountryShort, candidate.ASN, candidate.Residential, reason)
		return
	}
	s.fail(lastErr)
}

func (s *Slot) fail(err error) {
	if err == nil {
		err = errors.New("no candidate could establish a tunnel")
	}
	s.mu.Lock()
	s.state = StateError
	s.lastErr = err.Error()
	close(s.ready)
	s.mu.Unlock()
	s.logger.Printf("[matrix] slot=%d error: %v", s.id, err)
	go s.retryLater()
}

func (s *Slot) retryLater() {
	select {
	case <-s.ctx.Done():
		return
	case <-time.After(switchRetryWait):
	}
	s.mu.RLock()
	retry := s.state == StateError
	s.mu.RUnlock()
	if retry {
		s.RequestSwitch("retry", true)
	}
}

func (s *Slot) handleDown(tunnel *vpn.Tunnel, ip string) {
	s.mu.RLock()
	current := s.tunnel == tunnel && s.state == StateReady
	s.mu.RUnlock()
	if !current {
		return
	}
	s.RequestSwitch("session down "+ip, true)
}

func (s *Slot) candidates(previous model.Node, country, protocol, mode string, allowSameIP bool, settings config.Config) []model.Node {
	seen := make(map[string]struct{})
	result := make([]model.Node, 0, 24)
	add := func(nodes []model.Node) {
		for _, node := range nodes {
			if _, exists := seen[node.IP]; exists {
				continue
			}
			seen[node.IP] = struct{}{}
			result = append(result, node)
		}
	}
	exclude := s.manager.excludeIPs(s.id)
	if !allowSameIP && previous.IP != "" {
		exclude = append(exclude, previous.IP)
	}
	base := store.PoolFilter{
		Protocol:           protocol,
		ResidentialOnly:    settings.Matrix.ResidentialOnly,
		PreferredCountries: settings.Matrix.PreferredCountries,
		PreferredASNs:      settings.Matrix.PreferredASNs,
		Exclude:            exclude,
		Limit:              10,
	}
	fetch := func(filter store.PoolFilter) {
		nodes, err := s.manager.database.PoolCandidates(s.ctx, filter)
		if err != nil {
			s.logger.Printf("[matrix] slot=%d pool query: %v", s.id, err)
			return
		}
		add(nodes)
	}
	if allowSameIP && previous.IP != "" {
		node, ok, err := s.manager.database.PoolNode(s.ctx, previous.IP, protocol)
		if err != nil {
			s.logger.Printf("[matrix] slot=%d same-IP lookup: %v", s.id, err)
		} else if ok && (protocol == "" || contains(node.Protocols, protocol)) {
			add([]model.Node{node})
		}
	}
	if country != "" {
		sameCountry := base
		sameCountry.Country = country
		if previous.ASN != "" {
			withASN := sameCountry
			withASN.ASN = previous.ASN
			fetch(withASN)
		}
		fetch(sameCountry)
		return result
	}
	if previous.CountryShort != "" && mode != ModeRotating {
		sameCountry := base
		sameCountry.Country = previous.CountryShort
		if previous.ASN != "" {
			withASN := sameCountry
			withASN.ASN = previous.ASN
			fetch(withASN)
		}
		fetch(sameCountry)
	}
	fetch(base)
	return result
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func protocolForFailure(node model.Node, protocol string) string {
	if protocol != "" {
		return protocol
	}
	if len(node.Protocols) > 0 {
		return node.Protocols[0]
	}
	return ""
}

func (s *Slot) waitTunnel(ctx context.Context) (*vpn.Tunnel, error) {
	for {
		s.mu.RLock()
		state, tunnel, ready, lastErr := s.state, s.tunnel, s.ready, s.lastErr
		s.mu.RUnlock()
		switch state {
		case StateReady:
			if tunnel != nil {
				return tunnel, nil
			}
		case StateError:
			s.RequestSwitch("retry error", true)
			if lastErr == "" {
				lastErr = "slot is not connected"
			}
			return nil, errors.New(lastErr)
		case StateAllocated:
			s.RequestSwitch("allocate", true)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.ctx.Done():
			return nil, errors.New("slot is closed")
		case <-ready:
		}
	}
}

func (s *Slot) maybeRotate() {
	s.mu.RLock()
	mode := s.mode
	last := s.lastSwitch
	state := s.state
	s.mu.RUnlock()
	if mode != ModeRotating || state != StateReady {
		return
	}
	interval, err := s.manager.config.Get().Matrix.RotateIntervalDuration()
	if err != nil {
		return
	}
	if time.Since(last) >= interval {
		s.RequestSwitch("rotating interval", false)
	}
}

func (s *Slot) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	s.maybeRotate()
	tunnel, err := s.waitTunnel(ctx)
	if err != nil {
		return nil, err
	}
	connection, err := tunnel.DialContext(ctx, network, address)
	if err != nil {
		s.logger.Printf("[matrix] slot=%d dial %s: %v", s.id, address, err)
		s.RequestSwitch("dial failure", true)
	}
	return connection, err
}

func (s *Slot) ListenPacket(network, address string) (net.PacketConn, error) {
	tunnel, err := s.waitTunnel(context.Background())
	if err != nil {
		return nil, err
	}
	packets, err := tunnel.ListenPacket(network, address)
	if err != nil {
		s.RequestSwitch("packet failure", true)
	}
	return packets, err
}

func (s *Slot) ResolveIPv4(ctx context.Context, host string) ([]net.IP, error) {
	tunnel, err := s.waitTunnel(ctx)
	if err != nil {
		return nil, err
	}
	return tunnel.ResolveIPv4(ctx, host)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func probeExitIP(ctx context.Context, tunnel *vpn.Tunnel) string {
	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           tunnel.DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
			DisableKeepAlives:     true,
		},
		Timeout: 6 * time.Second,
	}
	for _, endpoint := range []string{"https://api.ipify.org", "https://checkip.amazonaws.com"} {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			continue
		}
		response, err := client.Do(request)
		if err != nil {
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 64))
		_ = response.Body.Close()
		if readErr != nil {
			continue
		}
		candidate := strings.TrimSpace(string(body))
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	return ""
}

func (s *Slot) Status() SlotStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	status := SlotStatus{
		SlotID:      s.id,
		Username:    s.username,
		Port:        s.port(),
		Mode:        s.mode,
		Protocol:    s.protocol,
		Country:     s.country,
		State:       s.state,
		ActiveIP:    firstNonEmpty(s.exitIP, s.node.IP),
		NodeIP:      s.node.IP,
		ExitIP:      s.exitIP,
		CountryShort: s.node.CountryShort,
		ASN:         s.node.ASN,
		ASNOrg:      s.node.ASNOrg,
		Residential: s.node.Residential,
		FailCount:   s.node.FailCount,
		LastError:   s.lastErr,
		LastSwitch:  s.lastSwitch,
	}
	return status
}

func (s *Slot) port() int {
	_, port, err := net.SplitHostPort(s.address)
	if err != nil {
		return 0
	}
	var number int
	_, _ = fmt.Sscanf(port, "%d", &number)
	return number
}

func (s *Slot) Close() error {
	s.cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	tunnel := s.tunnel
	s.tunnel = nil
	node := s.node
	exitIP := s.exitIP
	s.mu.Unlock()
	if node.IP != "" {
		s.manager.releaseNodeIP(node.IP, s.id)
	}
	if exitIP != "" {
		s.manager.releaseExitIP(exitIP, s.id)
	}
	if s.listener != nil {
		_ = s.listener.Close()
	}
	if tunnel != nil {
		return tunnel.Close()
	}
	return nil
}
