// Constants for file validation and chunking
const MAX_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks for stable upload
const MIN_CHUNK_SIZE = 256 * 1024; // 256KB minimum chunk size

// CRC32 table for streaming calculation
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
}

class FileBrowser {
    constructor() {
        this.currentPath = '';
        this.selectedFiles = new Set();
        this.cursorIndex = -1;
        this.lastSelectedIndex = -1;
        this.viewMode = 'list';
        this.sortField = 'name';
        this.sortDirection = 'asc';
        this.isDragging = false;
        this.dragStartIndex = -1;
        this.columnsCount = 1;
        
        // Load persisted settings
        const savedSettings = JSON.parse(localStorage.getItem('fileBrowserSettings') || '{}');
        this.sortField = savedSettings.sortField || 'name';
        this.sortDirection = savedSettings.sortDirection || 'asc';
        this.viewMode = savedSettings.viewMode || 'list';
        this.theme = savedSettings.theme || 'light';
        
        // Apply theme
        document.documentElement.dataset.theme = this.theme;
        
        this.setupEventListeners();
        
        // Try to restore last directory
        if (savedSettings.lastDirectory) {
            this.currentPath = savedSettings.lastDirectory;
        }
        
        this.loadCurrentDirectory().then(() => {
            // If directory load failed, reset to root
            if (document.querySelectorAll('.file-item').length === 0) {
                this.currentPath = '';
                this.loadCurrentDirectory();
            }
        });
        
        this.updateColumnsCount();
        
        // Add resize observer to update columns count
        this.resizeObserver = new ResizeObserver(() => {
            this.updateColumnsCount();
        });
        this.resizeObserver.observe(document.getElementById('file-browser'));
    }

    // Format file size with appropriate units
    formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }
        return `${size.toFixed(1)} ${units[unit]}`;
    }

    // Save current settings to localStorage
    saveSettings() {
        const settings = {
            sortField: this.sortField,
            sortDirection: this.sortDirection,
            viewMode: this.viewMode,
            theme: this.theme,
            lastDirectory: this.currentPath
        };
        localStorage.setItem('fileBrowserSettings', JSON.stringify(settings));
    }

    // Update columns count for grid view
    updateColumnsCount() {
        const browser = document.getElementById('file-browser');
        if (this.viewMode === 'grid') {
            const containerHeight = browser.clientHeight;
            const items = browser.querySelectorAll('.file-item');
            if (items.length > 0) {
                const itemHeight = items[0].offsetHeight;
                const rowsPerColumn = Math.floor(containerHeight / itemHeight);
                this.columnsCount = rowsPerColumn;
            }
        } else {
            this.columnsCount = 1;
        }
    }

    // Download selected files
    downloadSelected() {
        if (this.selectedFiles.size > 0) {
            const paths = Array.from(this.selectedFiles);
            this.downloadFiles(paths);
        } else {
            // If no selection but cursor is on a file, download that file
            const cursorItem = document.querySelector('.file-item.cursor');
            if (cursorItem && !cursorItem.classList.contains('parent-dir')) {
                this.downloadFiles([cursorItem.dataset.path]);
            }
        }
    }

    // Clear drag-over visual feedback
    clearDragOverClass() {
        document.querySelectorAll('.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
    }

    // Find drop target element
    findDropTarget(e) {
        return e.target.closest('.file-item');
    }

    // Update selection summary display
    updateSelectionSummary() {
        const summary = document.getElementById('selection-summary');
        if (this.selectedFiles.size === 0) {
            summary.classList.remove('visible');
            return;
        }

        const items = document.querySelectorAll('.file-item.selected');
        let totalSize = 0;
        let fileCount = 0;
        let dirCount = 0;

        items.forEach(item => {
            if (item.dataset.isDir === 'true') {
                dirCount++;
            } else {
                fileCount++;
                const sizeText = item.querySelector('.size').textContent;
                const size = this.parseSize(sizeText);
                if (!isNaN(size)) {
                    totalSize += size;
                }
            }
        });

        let text = '';
        if (fileCount > 0) {
            text += `${fileCount} file${fileCount !== 1 ? 's' : ''} (${this.formatSize(totalSize)})`;
        }
        if (dirCount > 0) {
            if (text) text += ', ';
            text += `${dirCount} folder${dirCount !== 1 ? 's' : ''}`;
        }

        summary.textContent = `Selected: ${text}`;
        summary.classList.add('visible');
    }

    // Parse size string back to bytes
    parseSize(sizeText) {
        const units = {
            'B': 1,
            'KB': 1024,
            'MB': 1024 * 1024,
            'GB': 1024 * 1024 * 1024,
            'TB': 1024 * 1024 * 1024 * 1024
        };
        
        const match = sizeText.match(/^([\d.]+)\s*([KMGT]?B)$/);
        if (!match) return NaN;
        
        const [, size, unit] = match;
        return parseFloat(size) * (units[unit] || 1);
    }

    // Calculate CRC32 for a chunk of data
    calculateCRC32(bytes, initialCrc = 0xFFFFFFFF) {
        let crc = initialCrc;
        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xFF];
        }
        return crc;
    }

    // Finalize CRC32 calculation
    finalizeCRC32(crc) {
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async handleFileDrop(files, targetPath) {
        if (!files || files.length === 0) {
            console.warn('No files to upload');
            return;
        }

        const MAX_RETRIES = 3;
        const RETRY_DELAY = 1000; // 1 second
        const PROGRESS_UPDATE_INTERVAL = 100; // Update progress every 100ms

        // Calculate optimal chunk size based on file size
        const getOptimalChunkSize = (fileSize) => {
            if (fileSize <= 1024 * 1024) { // <= 1MB
                return MIN_CHUNK_SIZE; // 256KB chunks
            } else if (fileSize <= 100 * 1024 * 1024) { // <= 100MB
                return Math.min(1024 * 1024, MAX_CHUNK_SIZE); // 1MB chunks or max
            } else if (fileSize <= 1024 * 1024 * 1024) { // <= 1GB
                return Math.min(5 * 1024 * 1024, MAX_CHUNK_SIZE); // 5MB chunks or max
            } else {
                return MAX_CHUNK_SIZE; // Maximum chunk size for very large files
            }
        };

        const progress = document.getElementById('upload-progress');
        progress.classList.remove('hidden');
        const progressBar = progress.querySelector('.progress');
        const progressText = progress.querySelector('.progress-text');

        const showMessage = (text, type = 'info', duration = 3000) => {
            const message = document.createElement('div');
            message.className = `upload-message ${type}`;
            message.textContent = text;
            document.body.appendChild(message);
            setTimeout(() => message.remove(), duration);
        };

        // Validate files before starting upload
        const validFiles = [];
        const invalidFiles = [];
        
        for (const file of files) {
            const validation = await this.validateFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                invalidFiles.push({ file, reason: validation.reason });
            }
        }

        // Show validation results
        if (invalidFiles.length > 0) {
            const message = invalidFiles.map(({ file, reason }) => 
                `${file.name}: ${reason}`
            ).join('\n');
            showMessage(`Some files were skipped:\n${message}`, 'error', 5000);
        }

        if (validFiles.length === 0) {
            progress.classList.add('hidden');
            return;
        }

        const totalSize = validFiles.reduce((acc, file) => acc + file.size, 0);
        let uploadedSize = 0;
        let lastProgressUpdate = 0;

        try {
            for (const file of validFiles) {
                const chunkSize = getOptimalChunkSize(file.size);
                const totalChunks = Math.ceil(file.size / chunkSize);
                let fileCrc = 0xFFFFFFFF;
                let uploadedChunks = 0;

                progressText.textContent = `Uploading ${file.name} (0/${totalChunks} chunks)...`;

                for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                    const start = chunkIndex * chunkSize;
                    const end = Math.min(start + chunkSize, file.size);
                    const chunk = file.slice(start, end);
                    const chunkBytes = new Uint8Array(await chunk.arrayBuffer());

                    // Calculate CRCs
                    const chunkCrc = this.finalizeCRC32(this.calculateCRC32(chunkBytes));
                    fileCrc = this.calculateCRC32(chunkBytes, fileCrc);

                    // Retry loop for chunk upload
                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        try {
                            const formData = new FormData();
                            formData.append('chunkInfo', JSON.stringify({
                                fileName: file.name,
                                chunkIndex: chunkIndex,
                                totalChunks: totalChunks,
                                chunkSize: end - start,
                                totalSize: file.size,
                                chunkChecksum: chunkCrc,
                                fileChecksum: chunkIndex === totalChunks - 1 ? this.finalizeCRC32(fileCrc) : 0
                            }));
                            formData.append('chunkData', chunk, 'chunk');

                            const response = await fetch(`/api/upload/chunk?dir=${encodeURIComponent(targetPath)}`, {
                                method: 'POST',
                                body: formData
                            });

                            if (!response.ok) {
                                throw new Error(await response.text());
                            }

                            uploadedChunks++;
                            uploadedSize += end - start;

                            // Update progress
                            const now = Date.now();
                            if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
                                const fileProgress = (uploadedChunks / totalChunks) * 100;
                                const totalProgress = (uploadedSize / totalSize) * 100;
                                progressBar.style.width = `${totalProgress}%`;
                                progressText.textContent = `Uploading ${file.name} (${uploadedChunks}/${totalChunks} chunks, ${fileProgress.toFixed(1)}%)`;
                                lastProgressUpdate = now;
                            }

                            break; // Success, exit retry loop
                        } catch (error) {
                            console.error(`Chunk ${chunkIndex} upload failed (attempt ${attempt + 1}):`, error);
                            if (attempt === MAX_RETRIES - 1) {
                                throw error;
                            }
                            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        }
                    }
                }
            }

            showMessage(`Successfully uploaded ${validFiles.length} file(s)`, 'success');
            await this.loadCurrentDirectory();
        } catch (error) {
            console.error('Upload error:', error);
            showMessage(error.message, 'error');
        } finally {
            setTimeout(() => {
                progress.classList.add('hidden');
                progressBar.style.width = '0';
                progressText.textContent = '';
            }, 1000);
        }
    }

    cleanup() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
    }

    setupEventListeners() {
        const browser = document.getElementById('file-browser');
        const downloadBtn = document.getElementById('download-btn');
        
        // View toggle
        document.querySelectorAll('.view-toggle button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.toggleViewMode(btn.dataset.view);
            });
        });

        // Sort controls
        document.querySelectorAll('.sort-control').forEach(btn => {
            btn.addEventListener('click', () => {
                const field = btn.dataset.sort;
                if (this.sortField === field) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortField = field;
                    this.sortDirection = 'asc';
                }
                this.updateSortIndicators();
                this.loadCurrentDirectory();
            });
        });

        // Mouse events
        browser.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        document.addEventListener('mouseup', () => this.handleMouseUp());

        // Single keyboard event listener
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));

        browser.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = this.findDropTarget(e);
            this.clearDragOverClass();
            if (target) {
                target.classList.add('drag-over');
            }
        });

        browser.addEventListener('dragleave', () => {
            this.clearDragOverClass();
        });

        browser.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const target = this.findDropTarget(e);
            this.clearDragOverClass();
            
            const targetPath = target && target.dataset.isDir === 'true' 
                ? target.dataset.path 
                : this.currentPath;

            await this.handleFileDrop(e.dataTransfer.files, targetPath);
        });

        downloadBtn.addEventListener('click', () => {
            if (this.selectedFiles.size > 0) {
                this.downloadSelected();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.selectAll();
            }
        });

        // File upload handling
        const fileUpload = document.getElementById('file-upload');
        if (fileUpload) {
            fileUpload.addEventListener('change', (e) => this.handleFileDrop(e.target.files, this.currentPath));
        }

        // Directory upload handling
        const dirUpload = document.getElementById('dir-upload');
        if (dirUpload) {
            dirUpload.addEventListener('change', (e) => this.handleFileDrop(e.target.files, this.currentPath));
        }

        // Set initial view mode button state
        document.querySelectorAll('.view-toggle button').forEach(btn => {
            if (btn.dataset.view === this.viewMode) {
                btn.classList.add('active');
            }
        });

        // Set initial sort indicators
        this.updateSortIndicators();

        // Theme toggle
        document.querySelector('.theme-toggle').addEventListener('click', () => {
            this.theme = this.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = this.theme;
            this.saveSettings();
        });

        // Delete button
        const deleteBtn = document.getElementById('delete-btn');
        deleteBtn.addEventListener('click', () => {
            if (this.selectedFiles.size > 0) {
                this.showDeleteConfirmation();
            }
        });
    }

    handleMouseDown(e) {
        const item = e.target.closest('.file-item');
        if (!item || item.classList.contains('parent-dir')) return;

        const index = Array.from(item.parentElement.children).indexOf(item);
        
        if (e.ctrlKey || e.metaKey) {
            this.toggleSelection(index);
        } else if (e.shiftKey && this.lastSelectedIndex !== -1) {
            this.selectRange(this.lastSelectedIndex, index);
        } else {
            this.clearSelection();
            this.setCursor(index);
            this.isDragging = true;
            this.dragStartIndex = index;
        }
        this.updateDownloadButtonState();
    }

    handleMouseMove(e) {
        if (!this.isDragging) return;

        const item = e.target.closest('.file-item');
        if (!item) return;

        const index = Array.from(item.parentElement.children).indexOf(item);
        this.selectRange(this.dragStartIndex, index);
    }

    handleMouseUp() {
        this.isDragging = false;
    }

    handleKeyDown(e) {
        const items = document.querySelectorAll('.file-item');
        if (!items.length) return;

        let nextIndex = this.cursorIndex;
        let shouldPreventDefault = true;

        if (this.viewMode === 'grid') {
            // Get all items' positions for visual navigation
            const itemPositions = Array.from(items).map((item, index) => {
                const rect = item.getBoundingClientRect();
                return { index, rect };
            });

            const currentRect = items[this.cursorIndex]?.getBoundingClientRect();
            if (!currentRect) return;

            switch (e.key) {
                case 'ArrowLeft': {
                    // Find the nearest item to the left
                    const leftItems = itemPositions.filter(p => 
                        p.rect.right < currentRect.left &&
                        Math.abs(p.rect.top - currentRect.top) < currentRect.height
                    );
                    if (leftItems.length) {
                        nextIndex = leftItems[leftItems.length - 1].index;
                    }
                    break;
                }
                case 'ArrowRight': {
                    // Find the nearest item to the right
                    const rightItems = itemPositions.filter(p => 
                        p.rect.left > currentRect.right &&
                        Math.abs(p.rect.top - currentRect.top) < currentRect.height
                    );
                    if (rightItems.length) {
                        nextIndex = rightItems[0].index;
                    }
                    break;
                }
                case 'ArrowUp': {
                    // Find the nearest item above
                    const aboveItems = itemPositions.filter(p => 
                        p.rect.bottom < currentRect.top &&
                        Math.abs(p.rect.left - currentRect.left) < currentRect.width
                    );
                    if (aboveItems.length) {
                        nextIndex = aboveItems[aboveItems.length - 1].index;
                    }
                    break;
                }
                case 'ArrowDown': {
                    // Find the nearest item below
                    const belowItems = itemPositions.filter(p => 
                        p.rect.top > currentRect.bottom &&
                        Math.abs(p.rect.left - currentRect.left) < currentRect.width
                    );
                    if (belowItems.length) {
                        nextIndex = belowItems[0].index;
                    }
                    break;
                }
                case 'PageUp': {
                    // Move one column left and scroll
                    const leftColumn = itemPositions.filter(p => 
                        p.rect.right < currentRect.left
                    );
                    if (leftColumn.length) {
                        const targetLeft = leftColumn[0].rect.left;
                        const sameRowItems = leftColumn.filter(p => 
                            Math.abs(p.rect.top - currentRect.top) < currentRect.height
                        );
                        nextIndex = sameRowItems.length ? sameRowItems[0].index : leftColumn[0].index;
                        
                        // Ensure we scroll one column left
                        const container = document.getElementById('file-browser');
                        container.scrollBy({
                            left: -container.clientWidth,
                            behavior: 'instant'
                        });
                    }
                    break;
                }
                case 'PageDown': {
                    // Move one column right and scroll
                    const rightColumn = itemPositions.filter(p => 
                        p.rect.left > currentRect.right
                    );
                    if (rightColumn.length) {
                        const targetLeft = rightColumn[0].rect.left;
                        const sameRowItems = rightColumn.filter(p => 
                            Math.abs(p.rect.top - currentRect.top) < currentRect.height
                        );
                        nextIndex = sameRowItems.length ? sameRowItems[0].index : rightColumn[0].index;
                        
                        // Ensure we scroll one column right
                        const container = document.getElementById('file-browser');
                        container.scrollBy({
                            left: container.clientWidth,
                            behavior: 'instant'
                        });
                    }
                    break;
                }
                default:
                    shouldPreventDefault = false;
            }
        } else {
            // List view navigation
            switch (e.key) {
                case 'ArrowUp':
                    nextIndex = Math.max(0, this.cursorIndex - 1);
                    break;
                case 'ArrowDown':
                    nextIndex = Math.min(items.length - 1, this.cursorIndex + 1);
                    break;
                case 'PageUp':
                    nextIndex = Math.max(0, this.cursorIndex - 10);
                    break;
                case 'PageDown':
                    nextIndex = Math.min(items.length - 1, this.cursorIndex + 10);
                    break;
                case 'Home':
                    nextIndex = 0;
                    break;
                case 'End':
                    nextIndex = items.length - 1;
                    break;
                default:
                    shouldPreventDefault = false;
            }
        }

        if (shouldPreventDefault) {
            e.preventDefault();
            e.stopPropagation(); // Prevent page scrolling
            if (nextIndex !== this.cursorIndex) {
                this.moveCursor(nextIndex - this.cursorIndex, e.shiftKey);
                this.scrollIntoView(items[nextIndex]);
            }
        }

        // Handle other keyboard shortcuts
        switch (e.key) {
            case 'Enter':
                if (this.cursorIndex >= 0) {
                    const item = items[this.cursorIndex];
                    const isDir = item.dataset.isDir === 'true';
                    if (isDir) {
                        this.currentPath = item.dataset.path;
                        this.loadCurrentDirectory();
                    } else {
                        this.downloadFiles([item.dataset.path]);
                    }
                }
                break;
            case 'Backspace':
                this.navigateUp();
                break;
            case 'a':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this.selectAll();
                }
                break;
            case '+':
            case '=':
                e.preventDefault();
                this.showGlobSelectionDialog(true);
                break;
            case '-':
                e.preventDefault();
                this.showGlobSelectionDialog(false);
                break;
            case ' ':
                e.preventDefault();
                if (this.cursorIndex >= 0) {
                    const item = items[this.cursorIndex];
                    this.toggleFileSelection(item, true);
                }
                break;
        }
    }

    moveCursor(delta, extendSelection) {
        const items = document.querySelectorAll('.file-item');
        if (!items.length) return;

        let newIndex;
        if (typeof delta === 'number') {
            if (this.cursorIndex === -1) {
                newIndex = delta >= 0 ? 0 : items.length - 1;
            } else {
                newIndex = this.cursorIndex + delta;
            }
        } else {
            newIndex = delta;
        }

        // Ensure index is within bounds
        newIndex = Math.max(0, Math.min(items.length - 1, newIndex));

        if (extendSelection) {
            if (this.lastSelectedIndex === -1) {
                this.lastSelectedIndex = this.cursorIndex;
            }
            const [min, max] = [Math.min(this.lastSelectedIndex, newIndex), 
                               Math.max(this.lastSelectedIndex, newIndex)];
            
            for (let i = min; i <= max; i++) {
                this.addToSelection(items[i]);
            }
        }
        
        this.setCursor(newIndex);
        this.scrollIntoView(items[newIndex]);
    }

    setCursor(index) {
        document.querySelectorAll('.file-item.cursor').forEach(el => {
            el.classList.remove('cursor');
        });
        
        const items = document.querySelectorAll('.file-item');
        if (index >= 0 && index < items.length) {
            items[index].classList.add('cursor');
            this.cursorIndex = index;
            this.lastSelectedIndex = index;
            this.updateDownloadButtonState();
        }
    }

    selectRange(start, end) {
        const items = document.querySelectorAll('.file-item');
        const [min, max] = [Math.min(start, end), Math.max(start, end)];
        
        this.clearSelection();
        for (let i = min; i <= max; i++) {
            this.addToSelection(items[i]);
        }
    }

    addToSelection(item) {
        if (item.classList.contains('parent-dir')) {
            return; // Don't allow selecting parent directory
        }
        item.classList.add('selected');
        this.selectedFiles.add(item.dataset.path);
        document.getElementById('download-btn').disabled = this.selectedFiles.size === 0;
        this.updateSelectionSummary();
    }

    clearSelection() {
        document.querySelectorAll('.file-item.selected').forEach(el => {
            el.classList.remove('selected');
        });
        this.selectedFiles.clear();
        this.updateDownloadButtonState();
        this.updateSelectionSummary();
    }

    updateDownloadButtonState() {
        const downloadBtn = document.getElementById('download-btn');
        const deleteBtn = document.getElementById('delete-btn');
        const cursorItem = document.querySelector('.file-item.cursor');
        
        // Enable download if there are selected files or if cursor is on a file (not parent dir)
        const hasSelection = this.selectedFiles.size > 0;
        const hasValidCursor = cursorItem && !cursorItem.classList.contains('parent-dir');
        
        downloadBtn.disabled = !hasSelection && !hasValidCursor;
        deleteBtn.disabled = !hasSelection; // Only enable delete for explicit selection
    }

    scrollIntoView(element) {
        if (!element) return;
        
        const container = document.getElementById('file-browser');
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const headerHeight = document.querySelector('.header-container').offsetHeight;

        if (this.viewMode === 'list') {
            // In list view, ensure the element is fully visible vertically
            const elementTop = elementRect.top - containerRect.top;
            const elementBottom = elementRect.bottom - containerRect.top;
            
            if (elementTop < headerHeight || elementBottom > containerRect.height) {
                const scrollTop = container.scrollTop + elementTop - headerHeight - 10;
                container.scrollTo({
                    top: scrollTop,
                    behavior: 'instant'
                });
            }
        } else {
            // In grid view, ensure the element is fully visible horizontally
            const elementLeft = elementRect.left - containerRect.left;
            const elementRight = elementRect.right - containerRect.left;
            
            if (elementLeft < 0 || elementRight > containerRect.width) {
                const scrollLeft = container.scrollLeft + elementLeft - 20;
                container.scrollTo({
                    left: scrollLeft,
                    behavior: 'instant'
                });
            }

            // Also check vertical visibility for grid view
            const elementTop = elementRect.top - containerRect.top;
            const elementBottom = elementRect.bottom - containerRect.top;
            
            if (elementTop < headerHeight || elementBottom > containerRect.height) {
                const scrollTop = container.scrollTop + elementTop - headerHeight - 10;
                container.scrollTo({
                    top: scrollTop,
                    behavior: 'instant'
                });
            }
        }
    }

    async loadCurrentDirectory() {
        try {
            const response = await fetch(`/api/list?dir=${encodeURIComponent(this.currentPath)}`);
            const files = await response.json();
            this.renderFiles(files);
            this.updatePathBar();
            // Set cursor to '..' or first item
            const items = document.querySelectorAll('.file-item');
            if (items.length > 0) {
                this.setCursor(0);
            }
            // Save current directory in settings
            this.saveSettings();
            return true;
        } catch (error) {
            console.error('Error loading directory:', error);
            return false;
        }
    }

    renderFiles(files) {
        const browser = document.getElementById('file-browser');
        browser.innerHTML = '';

        // Add parent directory entry unless we're at root
        if (this.currentPath) {
            const parentItem = document.createElement('div');
            parentItem.className = 'file-item parent-dir';
            parentItem.dataset.path = this.currentPath.split('/').slice(0, -1).join('/');
            parentItem.dataset.isDir = 'true';
            
            parentItem.innerHTML = `
                <span class="icon">📁</span>
                <span class="name">..</span>
                <span class="size"></span>
                <span class="modified"></span>
            `;

            parentItem.addEventListener('click', (e) => {
                if (e.detail === 2) { // double click
                    this.navigateUp();
                }
            });

            browser.appendChild(parentItem);
        }

        // Sort files
        const sortedFiles = this.sortFiles(files);

        sortedFiles.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.dataset.path = file.path;
            item.dataset.isDir = file.isDir;
            
            let formattedDate = '';
            try {
                const date = new Date(file.ModTime);
                if (!isNaN(date.getTime())) {  // Check if date is valid
                    formattedDate = new Intl.DateTimeFormat(undefined, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    }).format(date);
                }
            } catch (e) {
                console.warn('Invalid date:', file.ModTime);
            }
            
            item.innerHTML = `
                <span class="icon">${file.isDir ? '📁' : '📄'}</span>
                <span class="name">${file.name}</span>
                <span class="size">${file.isDir ? '' : this.formatSize(file.size)}</span>
                <span class="modified">${formattedDate}</span>
            `;

            // Handle double click
            let clickTimeout = null;
            item.addEventListener('click', (e) => {
                if (clickTimeout) {
                    // Double click
                    clearTimeout(clickTimeout);
                    clickTimeout = null;
                    this.handleDoubleClick(file);
                } else {
                    // Single click
                    clickTimeout = setTimeout(() => {
                        clickTimeout = null;
                        this.handleSingleClick(item, file, e);
                    }, 200);
                }
            });

            browser.appendChild(item);
        });
    }

    updatePathBar() {
        const pathBar = document.getElementById('path-bar');
        pathBar.innerHTML = `<span class="current-path">${this.currentPath || '/'}</span>`;
    }

    toggleFileSelection(item, multiSelect) {
        if (!multiSelect) {
            document.querySelectorAll('.file-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
            this.selectedFiles.clear();
        }

        item.classList.toggle('selected');
        const path = item.dataset.path;
        
        if (item.classList.contains('selected')) {
            this.selectedFiles.add(path);
        } else {
            this.selectedFiles.delete(path);
        }

        document.getElementById('download-btn').disabled = this.selectedFiles.size === 0;
    }

    selectAll() {
        const items = document.querySelectorAll('.file-item');
        items.forEach(item => {
            if (!item.classList.contains('parent-dir')) { // Don't select '..' entry
                this.addToSelection(item);
            }
        });
        document.getElementById('download-btn').disabled = this.selectedFiles.size === 0;
    }

    sortFiles(files) {
        // Handle null/undefined/empty files array
        if (!files || !Array.isArray(files)) {
            return [];
        }

        // Separate directories and files
        const dirs = files.filter(f => f.isDir);
        const regularFiles = files.filter(f => !f.isDir);

        // Sort function
        const compare = (a, b) => {
            let result = 0;
            switch (this.sortField) {
                case 'name':
                    result = a.name.localeCompare(b.name);
                    break;
                case 'size':
                    result = a.size - b.size;
                    break;
                case 'date':
                    try {
                        const dateA = new Date(a.ModTime);
                        const dateB = new Date(b.ModTime);
                        if (!isNaN(dateA) && !isNaN(dateB)) {
                            result = dateA - dateB;
                        }
                    } catch (e) {
                        result = 0;
                    }
                    break;
            }
            return this.sortDirection === 'asc' ? result : -result;
        };

        // Sort both arrays
        dirs.sort(compare);
        regularFiles.sort(compare);

        // Combine with directories always on top
        return [...dirs, ...regularFiles];
    }

    navigateUp() {
        if (this.currentPath) {
            const parentPath = this.currentPath.split('/').slice(0, -1).join('/');
            this.currentPath = parentPath;
            this.loadCurrentDirectory();
            this.saveSettings();
        }
    }

    downloadFiles(paths) {
        const queryString = paths.map(path => `paths=${encodeURIComponent(path)}`).join('&');
        const forceZip = paths.length > 1 ? '&zip=1' : '';
        window.location.href = `/api/download?${queryString}${forceZip}`;
    }

    showGlobSelectionDialog(isSelect) {
        const pattern = prompt(`Enter glob pattern to ${isSelect ? 'select' : 'deselect'} files (e.g., *.txt, doc*, etc.)`);
        if (!pattern) return;

        const regex = this.globToRegex(pattern);
        const items = document.querySelectorAll('.file-item');
        
        items.forEach(item => {
            const fileName = item.querySelector('.name').textContent;
            if (regex.test(fileName)) {
                if (isSelect) {
                    this.addToSelection(item);
                } else {
                    item.classList.remove('selected');
                    this.selectedFiles.delete(item.dataset.path);
                }
            }
        });

        document.getElementById('download-btn').disabled = this.selectedFiles.size === 0;
    }

    globToRegex(pattern) {
        const escapeRegex = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const converted = pattern
            .split('*')
            .map(escapeRegex)
            .join('.*');
        return new RegExp(`^${converted}$`, 'i');
    }

    async showDeleteConfirmation() {
        const items = document.querySelectorAll('.file-item.selected');
        let totalSize = 0;
        let fileCount = 0;
        let dirCount = 0;
        const fileList = [];

        items.forEach(item => {
            const name = item.querySelector('.name').textContent;
            const isDir = item.dataset.isDir === 'true';
            fileList.push(`${isDir ? '📁' : '📄'} ${name}`);
            
            if (isDir) {
                dirCount++;
            } else {
                fileCount++;
                const sizeText = item.querySelector('.size').textContent;
                const size = this.parseSize(sizeText);
                if (!isNaN(size)) {
                    totalSize += size;
                }
            }
        });

        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        
        const dialog = document.createElement('div');
        dialog.className = 'confirmation-dialog';
        
        let message = '<h2>Confirm Deletion</h2>';
        message += '<div class="content">';
        message += '<div class="warning">⚠️ This action cannot be undone!</div>';
        
        let summary = '';
        if (fileCount > 0) {
            summary += `${fileCount} file${fileCount !== 1 ? 's' : ''} (${this.formatSize(totalSize)})`;
        }
        if (dirCount > 0) {
            if (summary) summary += ' and ';
            summary += `${dirCount} folder${dirCount !== 1 ? 's' : ''}`;
        }
        
        message += `<p>You are about to delete ${summary}:</p>`;
        message += '<div class="file-list">';
        message += fileList.join('<br>');
        message += '</div>';
        
        if (dirCount > 0) {
            message += '<p class="warning">Warning: Folders and their contents will be permanently deleted!</p>';
        }
        
        message += '</div>';
        message += '<div class="actions">';
        message += '<button class="cancel">Cancel</button>';
        message += '<button class="danger confirm">Delete</button>';
        message += '</div>';
        
        dialog.innerHTML = message;
        
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        
        return new Promise((resolve) => {
            dialog.querySelector('.cancel').addEventListener('click', () => {
                overlay.remove();
                dialog.remove();
                resolve(false);
            });
            
            dialog.querySelector('.confirm').addEventListener('click', async () => {
                const paths = Array.from(this.selectedFiles);
                try {
                    const response = await fetch('/api/delete', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ paths }),
                    });
                    
                    if (!response.ok) {
                        throw new Error(await response.text());
                    }
                    
                    this.clearSelection();
                    await this.loadCurrentDirectory();
                    
                    const message = document.createElement('div');
                    message.className = 'upload-message success';
                    message.textContent = `Successfully deleted ${summary}`;
                    document.body.appendChild(message);
                    setTimeout(() => message.remove(), 3000);
                } catch (error) {
                    console.error('Delete error:', error);
                    const message = document.createElement('div');
                    message.className = 'upload-message error';
                    message.textContent = `Error deleting files: ${error.message}`;
                    document.body.appendChild(message);
                    setTimeout(() => message.remove(), 3000);
                } finally {
                    overlay.remove();
                    dialog.remove();
                    resolve(true);
                }
            });
            
            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    dialog.remove();
                    resolve(false);
                }
            });
            
            // Close on Escape key
            document.addEventListener('keydown', function handler(e) {
                if (e.key === 'Escape') {
                    overlay.remove();
                    dialog.remove();
                    document.removeEventListener('keydown', handler);
                    resolve(false);
                }
            });
        });
    }

    async validateFile(file) {
        // Only check for path traversal attempts
        if (file.name.includes('..') || file.name.startsWith('/')) {
            return {
                valid: false,
                reason: 'Invalid file name'
            };
        }

        return { valid: true };
    }

    handleSingleClick(item, file, e) {
        if (e.ctrlKey || e.metaKey) {
            this.toggleFileSelection(item, true);
        } else if (e.shiftKey && this.lastSelectedIndex !== -1) {
            const index = Array.from(item.parentElement.children).indexOf(item);
            this.selectRange(this.lastSelectedIndex, index);
        } else {
            this.clearSelection();
            this.setCursor(Array.from(item.parentElement.children).indexOf(item));
        }
    }

    handleDoubleClick(file) {
        if (file.isDir) {
            this.currentPath = file.path;
            this.loadCurrentDirectory();
            this.saveSettings();
        } else {
            this.downloadFiles([file.path]);
        }
    }

    toggleViewMode(mode) {
        const browser = document.getElementById('file-browser');
        const app = document.getElementById('app');
        
        browser.classList.remove('list-view', 'grid-view');
        browser.classList.add(`${mode}-view`);
        
        // Toggle app container class for grid mode
        if (mode === 'grid') {
            app.classList.add('grid-mode');
        } else {
            app.classList.remove('grid-mode');
        }
        
        this.viewMode = mode;
        this.updateColumnsCount();
        this.saveSettings();
    }

    updateSortIndicators() {
        document.querySelectorAll('.sort-control').forEach(btn => {
            btn.classList.remove('sort-asc', 'sort-desc');
            if (btn.dataset.sort === this.sortField) {
                btn.classList.add(`sort-${this.sortDirection}`);
            }
        });
        this.saveSettings();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new FileBrowser();
}); 