package main

import (
	"archive/zip"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"text/template"
	"time"

	http "github.com/Noooste/fhttp"
	"github.com/Noooste/websocket"
)

//go:embed static templates
var content embed.FS

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // In production, you might want to restrict this
	},
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"isDir"`
	ModTime string `json:"modTime"`
}

type ChunkInfo struct {
	FileName    string `json:"fileName"`
	ChunkIndex  int    `json:"chunkIndex"`
	TotalChunks int    `json:"totalChunks"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalSize   int64  `json:"totalSize"`
}

func main() {
	// Define command line flags
	var (
		chrootDir = flag.String("chroot", "", "Base directory to serve (required)")
		port      = flag.String("port", "8080", "Port to listen on (optional, default: 8080)")
		readOnly  = flag.Bool("readonly", false, "Enable read-only mode (optional, default: false)")
	)

	// Parse flags
	flag.Parse()

	// Validate required chroot argument
	if *chrootDir == "" {
		fmt.Fprintln(os.Stderr, "Error: -chroot argument is required")
		fmt.Fprintln(os.Stderr, "\nUsage:")
		flag.PrintDefaults()
		os.Exit(1)
	}

	// Resolve and validate chroot path
	baseDir, err := filepath.Abs(*chrootDir)
	if err != nil {
		log.Fatalf("Invalid chroot path: %v", err)
	}

	// Verify directory exists and is accessible
	if info, err := os.Stat(baseDir); err != nil || !info.IsDir() {
		log.Fatalf("Chroot directory does not exist or is not accessible: %v", err)
	}

	// Initialize security config
	securityConfig := DefaultSecurityConfig
	securityConfig.ReadOnly = *readOnly

	fs := http.FileServer(http.FS(content))
	http.Handle("/static/", fs)

	// Apply security middleware to all handlers
	http.HandleFunc("/", SecurityMiddleware(securityConfig, handleIndex(baseDir)))
	http.HandleFunc("/ws", SecurityMiddleware(securityConfig, handleWebSocket))
	http.HandleFunc("/api/list", SecurityMiddleware(securityConfig, handleList(baseDir)))
	http.HandleFunc("/api/upload", SecurityMiddleware(securityConfig, handleUpload(baseDir)))
	http.HandleFunc("/api/download", SecurityMiddleware(securityConfig, handleDownload(baseDir)))
	http.HandleFunc("/api/upload/chunk", SecurityMiddleware(securityConfig, handleChunkUpload(baseDir)))

	log.Printf("Starting server on :%s serving directory %s (read-only: %v)", *port, baseDir, *readOnly)
	if err := http.ListenAndServe(":"+*port, nil); err != nil {
		log.Fatal(err)
	}
}

func handleIndex(baseDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tmpl, err := template.ParseFS(content, "templates/index.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := tmpl.Execute(w, nil); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	}
}

func handleList(baseDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = baseDir
		} else {
			dir = filepath.Join(baseDir, dir)
		}

		// Prevent directory traversal
		if !strings.HasPrefix(dir, baseDir) {
			http.Error(w, "Invalid directory", http.StatusBadRequest)
			return
		}

		entries, err := os.ReadDir(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Separate directories and files
		var dirs, regularFiles []FileInfo
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				continue
			}

			relPath, _ := filepath.Rel(baseDir, filepath.Join(dir, entry.Name()))
			fileInfo := FileInfo{
				Name:    entry.Name(),
				Path:    relPath,
				Size:    info.Size(),
				IsDir:   entry.IsDir(),
				ModTime: info.ModTime().Format(time.RFC3339),
			}

			if entry.IsDir() {
				dirs = append(dirs, fileInfo)
			} else {
				regularFiles = append(regularFiles, fileInfo)
			}
		}

		// Sort directories and files separately
		sort.Slice(dirs, func(i, j int) bool {
			return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
		})
		sort.Slice(regularFiles, func(i, j int) bool {
			return strings.ToLower(regularFiles[i].Name) < strings.ToLower(regularFiles[j].Name)
		})

		// Combine sorted slices
		files := append(dirs, regularFiles...)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(files)
	}
}

type UploadProgress struct {
	FileName string  `json:"fileName"`
	Progress float64 `json:"progress"`
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Keep connection alive for progress updates
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

func handleUpload(baseDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		targetDir := r.URL.Query().Get("dir")
		if targetDir == "" {
			targetDir = baseDir
		} else {
			targetDir = filepath.Join(baseDir, targetDir)
		}

		if !strings.HasPrefix(targetDir, baseDir) {
			http.Error(w, "Invalid directory", http.StatusBadRequest)
			return
		}

		if err := r.ParseMultipartForm(32 << 20); err != nil {
			log.Printf("Error parsing multipart form: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		files := r.MultipartForm.File["files"]
		log.Printf("Received upload request for %d files to directory: %s", len(files), targetDir)

		uploadedFiles := make([]string, 0, len(files))
		for _, fileHeader := range files {
			log.Printf("Processing file: %s (size: %d bytes)", fileHeader.Filename, fileHeader.Size)

			file, err := fileHeader.Open()
			if err != nil {
				log.Printf("Error opening uploaded file %s: %v", fileHeader.Filename, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			defer file.Close()

			targetPath := filepath.Join(targetDir, fileHeader.Filename)
			dst, err := os.Create(targetPath)
			if err != nil {
				log.Printf("Error creating destination file %s: %v", targetPath, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			defer dst.Close()

			written, err := io.Copy(dst, file)
			if err != nil {
				log.Printf("Error writing file %s: %v", targetPath, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			log.Printf("Successfully uploaded file %s (%d bytes written)", fileHeader.Filename, written)
			uploadedFiles = append(uploadedFiles, fileHeader.Filename)
		}

		// Return success response with uploaded files list
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"message": fmt.Sprintf("Successfully uploaded %d files", len(uploadedFiles)),
			"files":   uploadedFiles,
		})
	}
}

func handleDownload(baseDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		paths := r.URL.Query()["paths"]
		if len(paths) == 0 {
			http.Error(w, "No files selected", http.StatusBadRequest)
			return
		}

		// If single file and not force zip
		if len(paths) == 1 && !r.URL.Query().Has("zip") {
			filePath := filepath.Join(baseDir, paths[0])
			if !strings.HasPrefix(filePath, baseDir) {
				http.Error(w, "Invalid path", http.StatusBadRequest)
				return
			}

			http.ServeFile(w, r, filePath)
			return
		}

		// Multiple files or force zip
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename=download.zip")

		zw := zip.NewWriter(w)
		defer zw.Close()

		for _, path := range paths {
			filePath := filepath.Join(baseDir, path)
			if !strings.HasPrefix(filePath, baseDir) {
				continue
			}

			err := filepath.Walk(filePath, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return err
				}

				if info.IsDir() {
					return nil
				}

				relPath, err := filepath.Rel(baseDir, path)
				if err != nil {
					return err
				}

				f, err := zw.Create(relPath)
				if err != nil {
					return err
				}

				src, err := os.Open(path)
				if err != nil {
					return err
				}
				defer src.Close()

				_, err = io.Copy(f, src)
				return err
			})
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
	}
}

func handleChunkUpload(baseDir string) http.HandlerFunc {
	var (
		activeUploads   = make(map[string]*ChunkedUpload)
		activeUploadsMu sync.RWMutex
	)

	// Cleanup routine for abandoned uploads
	go func() {
		for {
			time.Sleep(time.Minute)
			activeUploadsMu.Lock()
			for id, upload := range activeUploads {
				if time.Since(upload.LastActivity) > 10*time.Minute {
					upload.Cleanup()
					delete(activeUploads, id)
					log.Printf("Cleaned up abandoned upload: %s", id)
				}
			}
			activeUploadsMu.Unlock()
		}
	}()

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		targetDir := r.URL.Query().Get("dir")
		if targetDir == "" {
			targetDir = baseDir
		} else {
			targetDir = filepath.Join(baseDir, targetDir)
		}

		if !strings.HasPrefix(targetDir, baseDir) {
			http.Error(w, "Invalid directory", http.StatusBadRequest)
			return
		}

		// Parse chunk info
		var chunkInfo ChunkInfo
		if err := json.NewDecoder(r.Body).Decode(&chunkInfo); err != nil {
			http.Error(w, "Invalid chunk info", http.StatusBadRequest)
			return
		}

		// Generate upload ID based on filename and total size
		uploadID := fmt.Sprintf("%s_%d", chunkInfo.FileName, chunkInfo.TotalSize)

		activeUploadsMu.Lock()
		upload, exists := activeUploads[uploadID]
		if !exists {
			upload = NewChunkedUpload(chunkInfo.FileName, targetDir, chunkInfo.TotalChunks, chunkInfo.TotalSize)
			activeUploads[uploadID] = upload
			log.Printf("Started new chunked upload: %s (%d chunks, %d bytes)",
				chunkInfo.FileName, chunkInfo.TotalChunks, chunkInfo.TotalSize)
		}
		activeUploadsMu.Unlock()

		// Handle chunk data
		chunk := make([]byte, chunkInfo.ChunkSize)
		_, err := io.ReadFull(r.Body, chunk)
		if err != nil {
			http.Error(w, "Error reading chunk data", http.StatusBadRequest)
			return
		}

		if err := upload.WriteChunk(chunkInfo.ChunkIndex, chunk); err != nil {
			http.Error(w, fmt.Sprintf("Error writing chunk: %v", err), http.StatusInternalServerError)
			return
		}

		// Check if upload is complete
		if upload.IsComplete() {
			if err := upload.Finalize(); err != nil {
				http.Error(w, fmt.Sprintf("Error finalizing upload: %v", err), http.StatusInternalServerError)
				return
			}
			activeUploadsMu.Lock()
			delete(activeUploads, uploadID)
			activeUploadsMu.Unlock()
			log.Printf("Completed chunked upload: %s", chunkInfo.FileName)
		}

		w.WriteHeader(http.StatusOK)
	}
}

type ChunkedUpload struct {
	FileName     string
	TargetPath   string
	TotalChunks  int
	TotalSize    int64
	ReceivedSize int64
	Chunks       map[int][]byte
	TempDir      string
	LastActivity time.Time
	mu           sync.Mutex
}

func NewChunkedUpload(fileName, targetDir string, totalChunks int, totalSize int64) *ChunkedUpload {
	tempDir, err := os.MkdirTemp("", "upload_*")
	if err != nil {
		log.Printf("Error creating temp directory: %v", err)
		return nil
	}

	return &ChunkedUpload{
		FileName:     fileName,
		TargetPath:   filepath.Join(targetDir, fileName),
		TotalChunks:  totalChunks,
		TotalSize:    totalSize,
		Chunks:       make(map[int][]byte),
		TempDir:      tempDir,
		LastActivity: time.Now(),
	}
}

func (u *ChunkedUpload) WriteChunk(index int, data []byte) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	chunkPath := filepath.Join(u.TempDir, fmt.Sprintf("chunk_%d", index))
	if err := os.WriteFile(chunkPath, data, 0o644); err != nil {
		return err
	}

	u.ReceivedSize += int64(len(data))
	u.LastActivity = time.Now()
	return nil
}

func (u *ChunkedUpload) IsComplete() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.ReceivedSize >= u.TotalSize
}

func (u *ChunkedUpload) Finalize() error {
	u.mu.Lock()
	defer u.mu.Unlock()

	// Create target file
	dst, err := os.Create(u.TargetPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	// Combine chunks in order
	for i := 0; i < u.TotalChunks; i++ {
		chunkPath := filepath.Join(u.TempDir, fmt.Sprintf("chunk_%d", i))
		data, err := os.ReadFile(chunkPath)
		if err != nil {
			return err
		}
		if _, err := dst.Write(data); err != nil {
			return err
		}
	}

	// Cleanup temp files
	return u.Cleanup()
}

func (u *ChunkedUpload) Cleanup() error {
	return os.RemoveAll(u.TempDir)
}
