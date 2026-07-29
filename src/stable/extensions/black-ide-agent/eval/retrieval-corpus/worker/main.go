package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Entry point for the fulfilment worker. Everything interesting lives in
// handler.go and queue.go; this file is only lifecycle.
func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown: stop consuming on SIGTERM, then give in-flight handlers a
	// bounded moment to finish so a deploy does not nack work that had nearly
	// succeeded.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-signals
		log.Printf("received %s, draining", sig)
		cancel()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()

	log.Println("fulfilment worker started")
	if err := run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("worker exited: %v", err)
	}
}

func run(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}
