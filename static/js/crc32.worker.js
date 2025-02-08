const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
}

self.onmessage = async function(e) {
    const { id, chunk } = e.data;
    try {
        let crc = 0xFFFFFFFF;
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        
        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xFF];
        }
        
        self.postMessage({ id, checksum: (crc ^ 0xFFFFFFFF) >>> 0, error: null });
    } catch (error) {
        self.postMessage({ id, checksum: null, error: error.message });
    }
}; 