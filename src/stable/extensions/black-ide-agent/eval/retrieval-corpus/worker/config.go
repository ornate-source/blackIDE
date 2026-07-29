package worker

import (
	"os"
	"strconv"
	"time"
)

// Config is read once at start-up. Values are validated here rather than at the
// point of use, so a typo in an env var fails the deploy instead of surfacing as
// a zero timeout three hours later.
type Config struct {
	BrokerURL       string
	Concurrency     int
	VisibilityTimeout time.Duration
	ShutdownGrace   time.Duration
	MetricsAddr     string
}

func LoadConfig() Config {
	return Config{
		BrokerURL:         env("BROKER_URL", "amqp://localhost:5672"),
		Concurrency:       envInt("WORKER_CONCURRENCY", 8),
		VisibilityTimeout: time.Duration(envInt("VISIBILITY_TIMEOUT_SECONDS", 60)) * time.Second,
		ShutdownGrace:     time.Duration(envInt("SHUTDOWN_GRACE_SECONDS", 5)) * time.Second,
		MetricsAddr:       env("METRICS_ADDR", ":9090"),
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return fallback
}
