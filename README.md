# EZDrop

Simple and fast web-based file browser and transfer tool.

## Install

```bash
go install github.com/iamwavecut/ezdrop@latest
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
- Multi-file upload/download
- Directory upload support
- Sort by name/size/date
- File selection patterns (glob)

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
- Drag and drop support
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
- [x] File type validation
- [x] Upload size limits
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