package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"github.com/ExpTechTW/proxygate/internal/matrix"
)

type poolSlotResponse struct {
	matrix.SlotStatus
	SOCKS5 string `json:"socks5"`
}

func (s *Server) poolAuth(c fiber.Ctx) error {
	if s.matrix == nil || !s.matrix.Enabled() {
		return writeError(c, fiber.StatusServiceUnavailable, "matrix is disabled")
	}
	key := s.config.Get().Matrix.APIKey
	provided := c.Get(fiber.HeaderAuthorization)
	provided = strings.TrimSpace(strings.TrimPrefix(provided, "Bearer "))
	if key == "" || subtle.ConstantTimeCompare([]byte(key), []byte(provided)) != 1 {
		return writeError(c, fiber.StatusUnauthorized, "invalid API key")
	}
	return c.Next()
}

func (s *Server) poolSlots(c fiber.Ctx) error {
	statuses, _ := s.matrix.Status()
	settings := s.config.Get()
	host := s.socksHost()
	slots := make([]poolSlotResponse, 0, len(statuses))
	for index := range statuses {
		slots = append(slots, s.poolSlot(host, statuses[index]))
	}
	return writeJSON(c, fiber.StatusOK, map[string]any{
		"enabled":   true,
		"maxSlots":  settings.Matrix.Slots,
		"available": max(0, settings.Matrix.Slots-len(statuses)),
		"slots":     slots,
	})
}

func (s *Server) poolAllocate(c fiber.Ctx) error {
	options := matrix.AllocateOptions{}
	if len(c.Body()) > 0 {
		if !decodeJSON(c, &options) {
			return nil
		}
	}
	slot, created, err := s.matrix.Allocate(options)
	if err != nil {
		switch {
		case errors.Is(err, matrix.ErrDisabled):
			return writeError(c, fiber.StatusServiceUnavailable, err.Error())
		case errors.Is(err, matrix.ErrInvalid):
			return writeError(c, fiber.StatusBadRequest, err.Error())
		default:
			return writeError(c, fiber.StatusInternalServerError, err.Error())
		}
	}
	status := 200
	if created {
		status = fiber.StatusCreated
	}
	return writeJSON(c, status, map[string]any{
		"created": created,
		"slot":    s.poolSlot(s.socksHost(), slot.Status()),
	})
}

func (s *Server) poolRotate(c fiber.Ctx) error {
	slotID, err := strconv.Atoi(c.Params("slot_id"))
	if err != nil || slotID < 1 {
		return writeError(c, fiber.StatusBadRequest, "slot_id must be a positive integer")
	}
	if err := s.matrix.Rotate(slotID); err != nil {
		switch {
		case errors.Is(err, matrix.ErrNotFound):
			return writeError(c, fiber.StatusNotFound, err.Error())
		case errors.Is(err, matrix.ErrBusy):
			return writeError(c, fiber.StatusConflict, err.Error())
		default:
			return writeError(c, fiber.StatusInternalServerError, err.Error())
		}
	}
	statuses, _ := s.matrix.Status()
	for _, status := range statuses {
		if status.SlotID == slotID {
			return writeJSON(c, fiber.StatusAccepted, map[string]any{"slot": s.poolSlot(s.socksHost(), status)})
		}
	}
	return writeJSON(c, fiber.StatusAccepted, map[string]any{"slotId": slotID, "state": matrix.StateSwitching})
}

func (s *Server) poolStats(c fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stats, err := s.matrix.Stats(ctx)
	if err != nil {
		return writeError(c, fiber.StatusInternalServerError, err.Error())
	}
	return writeJSON(c, fiber.StatusOK, stats)
}

func (s *Server) socksHost() string {
	if host := s.config.Get().Matrix.PublicSocksHost; host != "" {
		return host
	}
	return "127.0.0.1"
}

func (s *Server) poolSlot(host string, status matrix.SlotStatus) poolSlotResponse {
	settings := s.config.Get()
	password := settings.Matrix.Password
	credential := url.UserPassword(status.Username, password)
	address := net.JoinHostPort(host, strconv.Itoa(status.Port))
	return poolSlotResponse{SlotStatus: status, SOCKS5: (&url.URL{Scheme: "socks5", User: credential, Host: address}).String()}
}
