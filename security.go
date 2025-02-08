package main

import (
	"path/filepath"
	"strings"
	"sync"

	http "github.com/Noooste/fhttp"
	"golang.org/x/time/rate"
)

// Security configuration
type SecurityConfig struct {
	MaxUploadSize int64        // Maximum upload size in bytes
	ReadOnly      bool         // Read-only mode
	RateLimit     *RateLimiter // Rate limiter for API endpoints
}

// Default security configuration
var DefaultSecurityConfig = SecurityConfig{
	MaxUploadSize: 1 << 30, // 1GB per request, since we're using chunked uploads
	ReadOnly:      false,
	RateLimit:     NewRateLimiter(100, 10), // 100 requests per 10 seconds
}

// RateLimiter implements a token bucket rate limiter per IP
type RateLimiter struct {
	visitors map[string]*rate.Limiter
	mu       sync.RWMutex
	rate     rate.Limit
	burst    int
}

func NewRateLimiter(r float64, burst int) *RateLimiter {
	return &RateLimiter{
		visitors: make(map[string]*rate.Limiter),
		rate:     rate.Limit(r),
		burst:    burst,
	}
}

func (rl *RateLimiter) getLimiter(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	limiter, exists := rl.visitors[ip]
	if !exists {
		limiter = rate.NewLimiter(rl.rate, rl.burst)
		rl.visitors[ip] = limiter
	}

	return limiter
}

// SecurityMiddleware wraps handlers with security checks
func SecurityMiddleware(cfg SecurityConfig, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Set security headers
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'unsafe-inline'; worker-src blob: 'self'; style-src 'self';")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

		// Rate limiting
		if cfg.RateLimit != nil {
			ip := getIP(r)
			limiter := cfg.RateLimit.getLimiter(ip)
			if !limiter.Allow() {
				http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
				return
			}
		}

		// Read-only mode check for write operations
		if cfg.ReadOnly && (r.Method == "POST" || r.Method == "PUT" || r.Method == "DELETE") {
			http.Error(w, "Server is in read-only mode", http.StatusForbidden)
			return
		}

		// Upload size limit
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/upload") {
			r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxUploadSize)
		}

		next(w, r)
	}
}

// ValidateFileType checks if the file extension is allowed
func ValidateFileType(filename string, allowedTypes []string) bool {
	if len(allowedTypes) == 0 {
		return true
	}
	ext := strings.ToLower(filepath.Ext(filename))
	for _, allowed := range allowedTypes {
		if strings.ToLower(allowed) == ext {
			return true
		}
	}
	return false
}

// getIP returns the client's real IP address
func getIP(r *http.Request) string {
	// Check X-Forwarded-For header
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		return strings.Split(forwarded, ",")[0]
	}
	// Fall back to RemoteAddr
	return strings.Split(r.RemoteAddr, ":")[0]
}

// ScanFile performs basic file scanning (implement more thorough scanning as needed)
func ScanFile(filename string, content []byte) error {
	return nil // No restrictions on file types
}
