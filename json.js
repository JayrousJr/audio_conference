// Replace the handleAudioChunk method in your admin panel's audioManager object

async handleAudioChunk(base64Audio, chunkNumber, format = 'unknown') {
    this.stats.chunksReceived++;
    this.stats.totalBytes += base64Audio.length;
    
    try {
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Determine MIME type based on format
        let mimeType;
        switch(format) {
            case 'webm':
                mimeType = 'audio/webm';
                break;
            case 'wav':
                mimeType = 'audio/wav';
                break;
            case 'm4a':
                mimeType = 'audio/mp4';
                break;
            case '3gpp':
            case '3gp':
                mimeType = 'audio/3gpp';
                break;
            default:
                mimeType = 'audio/mp4';
        }

        console.log(`Processing chunk ${chunkNumber} as ${mimeType} (format: ${format})`);

        // Create blob and audio element
        const blob = new Blob([bytes.buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio();

        // Test if audio can load
        const loadPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Load timeout'));
            }, 3000);

            audio.addEventListener('canplaythrough', () => {
                clearTimeout(timeout);
                console.log(`Chunk ${chunkNumber} loaded successfully`);
                resolve();
            }, { once: true });

            audio.addEventListener('error', (e) => {
                clearTimeout(timeout);
                console.error(`Failed to load chunk ${chunkNumber}:`, e);
                reject(e);
            }, { once: true });

            audio.src = url;
            audio.load();
        });

        try {
            await loadPromise;
            
            // Add to queue
            const chunkData = {
                audio: audio,
                url: url,
                buffer: bytes.buffer,
                chunkNumber: chunkNumber || this.stats.chunksReceived,
                played: false,
                format: format,
                mimeType: mimeType
            };
            
            this.queue.push(chunkData);
            this.updateStats();

            if (!this.isPlaying) {
                this.playNext();
            }
        } catch (error) {
            console.error(`Failed to load audio chunk ${chunkNumber}:`, error);
            this.stats.errors++;
            this.updateStats();
            
            // Save problematic chunk for debugging
            if (this.stats.errors === 1 || format === '3gpp') {
                this.downloadChunk(bytes.buffer, chunkNumber, format);
            }
        }

    } catch (error) {
        console.error('Error processing audio chunk:', error);
        this.stats.errors++;
        this.updateStats();
    }
},

// Add this helper method to download chunks for debugging
downloadChunk(buffer, chunkNumber, format) {
    const extension = format === 'webm' ? 'webm' : 
                     format === 'wav' ? 'wav' : 
                     format === '3gpp' ? '3gp' : 'm4a';
    
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chunk_${chunkNumber}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`Downloaded chunk ${chunkNumber} as .${extension} for debugging`);
    showNotification(`Downloaded chunk ${chunkNumber} for debugging`, 'info');
},

// Update the socket handler to pass format info
// In your admin panel's socket setup:
appState.socket.on("audio:stream", async (data) => {
    console.log("Audio chunk received:", {
        userName: data.userName,
        chunkNumber: data.chunkNumber,
        audioLength: data.audio ? data.audio.length : 0,
        format: data.format,
        originalFormat: data.originalFormat
    });

    if (data.audio) {
        await audioManager.handleAudioChunk(
            data.audio, 
            data.chunkNumber, 
            data.format || 'unknown'
        );
    }
});