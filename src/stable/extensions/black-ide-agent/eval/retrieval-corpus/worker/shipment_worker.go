package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"
)

// ShipmentBooked is emitted once a carrier label exists.
type ShipmentBooked struct {
	ShipmentID     string `json:"shipment_id"`
	OrderID        string `json:"order_id"`
	TrackingNumber string `json:"tracking_number"`
	Carrier        string `json:"carrier"`
}

// HandleShipmentBooked notifies the customer and starts tracking polls. Shares
// the queue plumbing with the order handler but has its own retry budget: a
// carrier API is far flakier than our own services and a shorter budget would
// dead-letter perfectly recoverable work.
func HandleShipmentBooked(ctx context.Context, q Queue, m Message) error {
	var event ShipmentBooked
	if err := json.Unmarshal(m.Body, &event); err != nil {
		return errors.Join(ErrPermanent, err)
	}
	if event.TrackingNumber == "" {
		return errors.Join(ErrPermanent, errors.New("booked event without a tracking number"))
	}

	backoff := Backoff{Base: time.Second, Max: 2 * time.Minute, Multiplier: 2.0, Jitter: true}
	return backoff.Do(6, func() error {
		return q.Publish(ctx, "shipments.tracking.requested", map[string]any{
			"shipment_id":     event.ShipmentID,
			"tracking_number": event.TrackingNumber,
			"carrier":         event.Carrier,
		})
	}, func(err error) bool {
		return !errors.Is(err, ErrPermanent)
	})
}

// PollTracking asks the carrier for a status update on a fixed cadence.
func PollTracking(ctx context.Context, q Queue, every time.Duration) error {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := q.Publish(ctx, "shipments.tracking.poll", map[string]any{"at": time.Now()}); err != nil {
				log.Printf("tracking poll: %v", err)
			}
		}
	}
}
