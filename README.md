# EZDrop

Simple and fast web-based file browser and transfer tool.


https://github.com/user-attachments/assets/3e0cba7f-cad4-4d48-8cf5-9ddf57ff7f37


## Install

### Using Go

```bash
go install github.com/iamwavecut/ezdrop@latest
```

### Pre-built Binaries

Download the latest release for your platform:
- **Linux**
  - amd64:
    ```bash
    curl -L https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-linux-amd64.tar.gz | tar xz && sudo mv ezdrop /usr/local/bin/
    ```
  - arm64:
    ```bash
    curl -L https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-linux-arm64.tar.gz | tar xz && sudo mv ezdrop /usr/local/bin/
    ```

- **Windows** (Run in PowerShell as Administrator)
  - amd64:
    ```powershell
    Invoke-WebRequest -Uri https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-windows-amd64.zip -OutFile ezdrop.zip; Expand-Archive ezdrop.zip -DestinationPath $env:USERPROFILE\ezdrop; Move-Item $env:USERPROFILE\ezdrop\ezdrop.exe $env:USERPROFILE\AppData\Local\Microsoft\WindowsApps\
    ```
  - arm64:
    ```powershell
    Invoke-WebRequest -Uri https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-windows-arm64.zip -OutFile ezdrop.zip; Expand-Archive ezdrop.zip -DestinationPath $env:USERPROFILE\ezdrop; Move-Item $env:USERPROFILE\ezdrop\ezdrop.exe $env:USERPROFILE\AppData\Local\Microsoft\WindowsApps\
    ```

- **macOS**
  - amd64:
    ```bash
    curl -L https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-darwin-amd64.tar.gz | tar xz && sudo mv ezdrop /usr/local/bin/
    ```
  - arm64:
    ```bash
    curl -L https://github.com/iamwavecut/ezdrop/releases/latest/download/ezdrop-darwin-arm64.tar.gz | tar xz && sudo mv ezdrop /usr/local/bin/
    ```

## Usage

Run the server:

```bash
ezdrop -chroot /path/to/serve
```

Options:
- `-chroot` (required): Base directory to serve
- `-port` (optional): Port to listen on (default: 8080)
- `-readonly` (optional): Enable read-only mode (default: false)

Examples:

```bash
# Run with custom port
ezdrop -chroot /home/user/files -port 3000

# Run in read-only mode
ezdrop -chroot /home/user/files -readonly
```

## Features

### File Management
- File browser with list/grid views
- Multi-file upload/download with progress tracking
- Chunked file upload support for large files
- Directory upload support
- Sort by name/size/date
- File selection patterns (glob)

### Upload Features
- Supports any file type and size
- Chunked upload with automatic size optimization
- Checksum verification for data integrity
- Upload progress tracking:
  - Overall progress across all files
  - Per-file progress with chunk information
  - Visual progress bars
  - File size and transfer speed display
- Automatic retry on failed chunks
- Drag and drop support

### Navigation
- Keyboard navigation
  - Arrow keys: Move cursor
  - Space: Toggle selection
  - Enter: Open directory/download file
  - Backspace: Navigate up
  - Home/End: Jump to start/end
  - PageUp/PageDown: Move by page/column
  - Ctrl+A: Select all
  - +/-: Select/deselect by pattern

### Interface
- Dark/light theme toggle
- List and grid view modes
- Responsive design
- Progress indicators
- File size formatting
- Date/time display

### Selection
- Single click: Set cursor
- Double click: Open/download
- Shift+click: Range select
- Ctrl+click: Toggle selection
- Drag select: Multiple files
- Pattern selection (*.txt, doc*, etc.)

## Security

- [x] Enforced chroot directory
- [x] Path traversal protection
- [x] Rate limiting
- [x] Security headers
- [x] Read-only mode

## Development

Built with:
- Go 1.23+
- Modern JavaScript (no frameworks)
- CSS Grid/Flexbox

## License

MIT License 
