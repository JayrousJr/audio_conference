// Replace the handleAudioChunk function in your admin panel with this enhanced version

async function handleAudioChunk(base64Audio, chunkNumber) {
	try {
		// Update stats
		audioStats.chunksReceived++;
		audioStats.totalBytes += base64Audio.length;
		audioStats.lastChunkTime = Date.now();
		updateAudioStats();

		// Convert base64 to blob
		const binaryString = atob(base64Audio);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}

		// Try multiple MIME types
		const mimeTypes = [
			"audio/mp4",
			"audio/m4a",
			"audio/mpeg",
			"audio/aac",
			"audio/3gp",
			"video/3gpp", // Sometimes m4a files are recognized as 3gpp
		];

		let audioLoaded = false;
		let lastError = null;

		for (const mimeType of mimeTypes) {
			if (audioLoaded) break;

			try {
				// Create blob with current MIME type
				const blob = new Blob([bytes.buffer], { type: mimeType });
				const audioUrl = URL.createObjectURL(blob);

				// Create audio element
				const audio = new Audio();

				// Create a promise to handle loading
				const loadPromise = new Promise((resolve, reject) => {
					let loadTimeout;

					const cleanup = () => {
						clearTimeout(loadTimeout);
						audio.removeEventListener("canplaythrough", onLoad);
						audio.removeEventListener("error", onError);
						audio.removeEventListener("loadedmetadata", onMetadata);
					};

					const onLoad = () => {
						cleanup();
						console.log(
							`Chunk ${chunkNumber} loaded successfully with MIME type: ${mimeType}`
						);
						audioLoaded = true;
						resolve({ audio, audioUrl, mimeType });
					};

					const onError = (e) => {
						cleanup();
						console.log(
							`Failed to load chunk ${chunkNumber} with MIME type ${mimeType}`
						);
						reject(e);
					};

					const onMetadata = () => {
						console.log(
							`Chunk ${chunkNumber} metadata loaded, duration: ${audio.duration}s`
						);
					};

					audio.addEventListener("canplaythrough", onLoad, { once: true });
					audio.addEventListener("error", onError, { once: true });
					audio.addEventListener("loadedmetadata", onMetadata, { once: true });

					// Set source and try to load
					audio.src = audioUrl;
					audio.load();

					// Timeout after 3 seconds
					loadTimeout = setTimeout(() => {
						cleanup();
						reject(new Error("Load timeout"));
					}, 3000);
				});

				// Try to load with this MIME type
				const result = await loadPromise;

				// Success! Add to queue
				const queueItem = {
					audio: result.audio,
					url: result.audioUrl,
					chunkNumber: chunkNumber || audioStats.chunksReceived,
					loaded: true,
					mimeType: result.mimeType,
				};
				audioQueue.push(queueItem);

				// Start processing if not already doing so
				if (!isProcessingAudio) {
					processAudioQueue();
				}

				break; // Success, exit the loop
			} catch (error) {
				lastError = error;
				console.log(`MIME type ${mimeType} failed for chunk ${chunkNumber}`);
				// Continue to next MIME type
			}
		}

		if (!audioLoaded) {
			console.error(
				`All MIME types failed for chunk ${chunkNumber}`,
				lastError
			);
			audioStats.errors++;
			updateAudioStats();

			// Save the first chunk for debugging
			if (chunkNumber === 1) {
				saveChunkForDebug(bytes.buffer, chunkNumber);
			}
		}
	} catch (error) {
		console.error("Error handling audio chunk:", error);
		audioStats.errors++;
		updateAudioStats();
	}
}

// Add this function to save a chunk for debugging
function saveChunkForDebug(arrayBuffer, chunkNumber) {
	try {
		const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
		const url = URL.createObjectURL(blob);

		const a = document.createElement("a");
		a.href = url;
		a.download = `audio_chunk_${chunkNumber}_debug.m4a`;
		a.style.display = "none";
		document.body.appendChild(a);
		a.click();

		setTimeout(() => {
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}, 100);

		console.log(`Saved chunk ${chunkNumber} for debugging`);
	} catch (error) {
		console.error("Error saving debug chunk:", error);
	}
}

// Also update the processAudioQueue function for better error handling
async function processAudioQueue() {
	if (isProcessingAudio || audioQueue.length === 0) {
		return;
	}

	// Find next playable chunk
	const nextChunk = audioQueue.find((item) => item.loaded && !item.played);
	if (!nextChunk) {
		// No chunks ready yet
		return;
	}

	isProcessingAudio = true;
	const audio = nextChunk.audio;

	console.log(
		`Attempting to play chunk ${nextChunk.chunkNumber} (MIME: ${nextChunk.mimeType})`
	);

	try {
		// Set volume
		audio.volume = 1.0;

		// Set up ended handler before playing
		audio.addEventListener(
			"ended",
			() => {
				console.log(`Chunk ${nextChunk.chunkNumber} finished playing`);
				audioStats.chunksPlayed++;
				updateAudioStats();

				// Clean up
				URL.revokeObjectURL(nextChunk.url);
				nextChunk.played = true;

				// Process next chunk
				isProcessingAudio = false;
				processAudioQueue();
			},
			{ once: true }
		);

		// Try to play
		const playPromise = audio.play();

		if (playPromise !== undefined) {
			await playPromise;
			console.log(`Successfully playing chunk ${nextChunk.chunkNumber}`);
		}
	} catch (error) {
		console.error(`Play error for chunk ${nextChunk.chunkNumber}:`, error);

		if (error.name === "NotAllowedError") {
			showNotification('Please click "Enable Audio" button first', "error");
		} else if (error.name === "NotSupportedError") {
			showNotification("Audio format not supported", "error");
		} else {
			showNotification(`Audio error: ${error.message}`, "error");
		}

		audioStats.errors++;
		updateAudioStats();

		// Mark as played to skip it
		nextChunk.played = true;
		isProcessingAudio = false;

		// Try next chunk
		setTimeout(() => processAudioQueue(), 100);
	}
}

// Add this test function to check if we can decode the audio
async function testAudioDecoding() {
	if (!audioContext) {
		console.error("Audio context not initialized");
		return;
	}

	// Get the first audio chunk from the queue
	const firstChunk = audioQueue[0];
	if (!firstChunk) {
		console.error("No audio chunks in queue");
		return;
	}

	try {
		const response = await fetch(firstChunk.url);
		const arrayBuffer = await response.arrayBuffer();

		console.log("Attempting to decode audio with Web Audio API...");
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

		console.log("Audio decoded successfully!", {
			duration: audioBuffer.duration,
			sampleRate: audioBuffer.sampleRate,
			numberOfChannels: audioBuffer.numberOfChannels,
		});

		// Play it through Web Audio API
		const source = audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(audioContext.destination);
		source.start();

		showNotification("Audio decoded and playing via Web Audio API", "success");
	} catch (error) {
		console.error("Failed to decode audio:", error);
		showNotification("Audio format incompatible with Web Audio API", "error");
	}
}
