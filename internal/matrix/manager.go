package matrix

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ExpTechTW/proxygate/internal/config"
	"github.com/ExpTechTW/proxygate/internal/store"
	"github.com/ExpTechTW/proxygate/internal/vpn"
)

var (
	ErrDisabled = errors.New("matrix is disabled")
	ErrNotFound = errors.New("matrix slot is not allocated")
	ErrInvalid  = errors.New("invalid matrix request")
	ErrBusy     = errors.New("matrix slot is already switching")
)

type AllocateOptions struct {
	Country  string `json:"country"`
	Protocol string `json:"protocol"`
	Mode     string `json:"mode"`
	SlotID   int    `json:"slot_id"`
}

type SlotStatus struct {
	SlotID       int       `json:"slotId"`
	Username     string    `json:"username"`
	Port         int       `json:"port"`
	Mode         string    `json:"mode"`
	Protocol     string    `json:"protocol,omitempty"`
	Country      string    `json:"country,omitempty"`
	State        string    `json:"state"`
	ActiveIP     string    `json:"activeIp,omitempty"`
	NodeIP       string    `json:"nodeIp,omitempty"`
	ExitIP       string    `json:"exitIp,omitempty"`
	CountryShort string    `json:"countryShort,omitempty"`
	ASN          string    `json:"asn,omitempty"`
	ASNOrg       string    `json:"asnOrg,omitempty"`
	Residential  bool      `json:"residential"`
	FailCount    int       `json:"failCount"`
	LastError    string    `json:"lastError,omitempty"`
	LastSwitch   time.Time `json:"lastSwitch,omitzero"`
}

type Stats struct {
	Pool      store.PoolStats `json:"pool"`
	Slots     int             `json:"slots"`
	Ready     int             `json:"ready"`
	ActiveIPs []string        `json:"activeIps"`
}

type Manager struct {
	ctx      context.Context
	cancel   context.CancelFunc
	config   *config.Store
	database *store.Store
	logger   *log.Logger
	drivers  []vpn.Driver

	mu          sync.RWMutex
	slots       map[int]*Slot
	activeNodes map[string]int
	activeExits map[string]int
	started     bool
}

func NewManager(parent context.Context, configStore *config.Store, database *store.Store, logger *log.Logger, drivers []vpn.Driver) *Manager {
	ctx, cancel := context.WithCancel(parent)
	return &Manager{
		ctx:      ctx,
		cancel:   cancel,
		config:   configStore,
		database: database,
		logger:   logger,
		drivers:  drivers,
		slots:       make(map[int]*Slot),
		activeNodes: make(map[string]int),
		activeExits: make(map[string]int),
	}
}

func (m *Manager) Start() error {
	settings := m.config.Get()
	if !settings.Matrix.Enabled {
		return ErrDisabled
	}
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return nil
	}
	m.started = true
	m.mu.Unlock()
	if settings.Matrix.Autostart {
		go func() {
			for id := 1; id <= settings.Matrix.Slots; id++ {
				if m.ctx.Err() != nil {
					return
				}
				if _, _, err := m.Allocate(AllocateOptions{SlotID: id, Mode: ModeSticky}); err != nil {
					m.logger.Printf("[matrix] autostart slot=%d: %v", id, err)
				}
			}
		}()
	}
	m.logger.Printf("[matrix] started slots=%d ports=%d-%d", settings.Matrix.Slots, settings.Matrix.PortStart, settings.Matrix.PortStart+settings.Matrix.Slots-1)
	return nil
}

func (m *Manager) Close() error {
	m.cancel()
	m.mu.Lock()
	slots := make([]*Slot, 0, len(m.slots))
	for _, slot := range m.slots {
		slots = append(slots, slot)
	}
	m.slots = make(map[int]*Slot)
	m.activeNodes = make(map[string]int)
	m.activeExits = make(map[string]int)
	m.mu.Unlock()
	var result error
	for _, slot := range slots {
		if err := slot.Close(); err != nil {
			result = errors.Join(result, err)
		}
	}
	return result
}

func (m *Manager) Allocate(options AllocateOptions) (*Slot, bool, error) {
	settings := m.config.Get()
	if !settings.Matrix.Enabled {
		return nil, false, ErrDisabled
	}
	country := strings.ToUpper(strings.TrimSpace(options.Country))
	if country != "" && (len(country) != 2 || strings.Trim(country, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") != "") {
		return nil, false, fmt.Errorf("%w: country must be a two-letter code", ErrInvalid)
	}
	mode := strings.ToLower(strings.TrimSpace(options.Mode))
	if mode == "" {
		mode = ModeSticky
	}
	if mode != ModeSticky && mode != ModeRotating {
		return nil, false, fmt.Errorf("%w: mode must be sticky or rotating", ErrInvalid)
	}
	protocol := strings.TrimSpace(options.Protocol)
	if protocol != "" && !m.supportsProtocol(protocol) {
		return nil, false, fmt.Errorf("%w: unsupported protocol %q", ErrInvalid, protocol)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return nil, false, errors.New("matrix manager is closed")
	}
	if options.SlotID != 0 {
		if options.SlotID < 1 || options.SlotID > settings.Matrix.Slots {
			return nil, false, fmt.Errorf("%w: slotId must be between 1 and %d", ErrInvalid, settings.Matrix.Slots)
		}
		if existing, exists := m.slots[options.SlotID]; exists {
			existing.Configure(country, protocol, mode)
			return existing, false, nil
		}
	} else {
		for id := 1; id <= settings.Matrix.Slots; id++ {
			if _, exists := m.slots[id]; !exists {
				options.SlotID = id
				break
			}
		}
		if options.SlotID == 0 {
			return nil, false, fmt.Errorf("%w: all %d slots are allocated", ErrInvalid, settings.Matrix.Slots)
		}
	}
	slot := newSlot(m.ctx, m, options.SlotID)
	slot.mode = mode
	slot.country = country
	slot.protocol = protocol
	if err := slot.Start(); err != nil {
		return nil, false, err
	}
	m.slots[options.SlotID] = slot
	slot.RequestSwitch("allocate", true)
	return slot, true, nil
}

func (m *Manager) Rotate(slotID int) error {
	m.mu.RLock()
	slot, exists := m.slots[slotID]
	m.mu.RUnlock()
	if !exists {
		return ErrNotFound
	}
	if !slot.Rotate() {
		return ErrBusy
	}
	return nil
}

func (m *Manager) Status() ([]SlotStatus, int) {
	m.mu.RLock()
	slots := make([]*Slot, 0, len(m.slots))
	for _, slot := range m.slots {
		slots = append(slots, slot)
	}
	m.mu.RUnlock()
	statuses := make([]SlotStatus, 0, len(slots))
	ready := 0
	for _, slot := range slots {
		status := slot.Status()
		if status.State == StateReady {
			ready++
		}
		statuses = append(statuses, status)
	}
	sort.Slice(statuses, func(left, right int) bool { return statuses[left].SlotID < statuses[right].SlotID })
	return statuses, ready
}

func (m *Manager) Stats(ctx context.Context) (Stats, error) {
	pool, err := m.database.PoolStats(ctx)
	if err != nil {
		return Stats{}, err
	}
	statuses, ready := m.Status()
	active := make([]string, 0, len(statuses))
	for _, status := range statuses {
		if status.ActiveIP != "" {
			active = append(active, status.ActiveIP)
		}
	}
	return Stats{Pool: pool, Slots: len(statuses), Ready: ready, ActiveIPs: active}, nil
}

func (m *Manager) AfterHarvest(context.Context) {}

func (m *Manager) Enabled() bool {
	return m.config.Get().Matrix.Enabled
}

func (m *Manager) SupportsProtocol(protocol string) bool {
	return m.supportsProtocol(protocol)
}

func (m *Manager) supportsProtocol(protocol string) bool {
	for _, driver := range m.drivers {
		if driver.Protocol() == protocol {
			return true
		}
	}
	return false
}

func (m *Manager) reserveNodeIP(ip string, slotID int) bool {
	return m.reserveIP(m.activeNodes, ip, slotID)
}

func (m *Manager) reserveExitIP(ip string, slotID int) bool {
	return m.reserveIP(m.activeExits, ip, slotID)
}

func (m *Manager) reserveIP(active map[string]int, ip string, slotID int) bool {
	if ip == "" {
		return true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner, exists := active[ip]; exists && owner != slotID {
		return false
	}
	active[ip] = slotID
	return true
}

func (m *Manager) releaseNodeIP(ip string, slotID int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner, exists := m.activeNodes[ip]; exists && owner == slotID {
		delete(m.activeNodes, ip)
	}
}

func (m *Manager) releaseExitIP(ip string, slotID int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner, exists := m.activeExits[ip]; exists && owner == slotID {
		delete(m.activeExits, ip)
	}
}

func (m *Manager) excludeIPs(slotID int) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	seen := make(map[string]struct{}, len(m.activeNodes)+len(m.activeExits))
	result := make([]string, 0, len(seen))
	for _, active := range []map[string]int{m.activeNodes, m.activeExits} {
		for ip, owner := range active {
			if owner == slotID {
				continue
			}
			if _, exists := seen[ip]; exists {
				continue
			}
			seen[ip] = struct{}{}
			result = append(result, ip)
		}
	}
	return result
}
