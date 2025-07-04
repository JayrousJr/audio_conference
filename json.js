// SIMPLE ALTERNATIVE METHOD
// Instead of recording in chunks, record one continuous audio file
// and send status updates to the server

// In your App.js, replace the startRecordingAndStreaming function with this:

const startRecordingAndStreaming = async (socketConnection) => {
	try {
		// Request permissions
		const { status } = await Audio.requestPermissionsAsync();
		if (status !== "granted") {
			Alert.alert("Permission Denied", "Microphone permission is required");
			return;
		}

		// Configure audio
		await Audio.setAudioModeAsync({
			allowsRecordingIOS: true,
			playsInSilentModeIOS: true,
			playThroughEarpieceAndroid: false,
			staysActiveInBackground: true,
			shouldDuckAndroid: false,
		});

		// Create ONE recording that will run until stopped
		console.log("Starting continuous recording...");
		const { recording: newRecording } = await Audio.Recording.createAsync(
			Audio.RecordingOptionsPresets.HIGH_QUALITY
		);

		setRecording(newRecording);

		// Send periodic updates to show we're still recording
		const updateInterval = setInterval(() => {
			if (isSpeaking) {
				// Just send a status update, not audio
				socketConnection.emit("audio:status", {
					isRecording: true,
					timestamp: Date.now(),
				});
				console.log("Still recording...");
			}
		}, 2000); // Every 2 seconds

		// Store the interval so we can clear it later
		recordingInterval.current = {
			interval: updateInterval,
			recording: newRecording,
		};

		console.log("Recording started successfully");
	} catch (error) {
		console.error("Failed to start recording", error);
		Alert.alert("Error", "Failed to start recording");
	}
};

// Update the stopRecording function:
const stopRecording = async () => {
	console.log("Stopping recording...");
	setIsSpeaking(false);
	setAudioChunks(0);

	if (recordingInterval.current) {
		// Clear the update interval
		clearInterval(recordingInterval.current.interval);

		// Stop and get the recording
		const recording = recordingInterval.current.recording;
		if (recording) {
			try {
				await recording.stopAndUnloadAsync();
				const uri = recording.getURI();

				if (uri) {
					console.log("Recording complete, sending to server...");

					// Read the entire recording
					const base64Audio = await FileSystem.readAsStringAsync(uri, {
						encoding: FileSystem.EncodingType.Base64,
					});

					// If the audio is too large, split it into chunks
					const MAX_CHUNK_SIZE = 500000; // 500KB chunks

					if (base64Audio.length <= MAX_CHUNK_SIZE) {
						// Small enough to send in one piece
						socket.emit("audio:complete", {
							audio: base64Audio,
							duration: recording._finalDurationMillis,
						});
					} else {
						// Split into multiple chunks
						let chunkNumber = 0;
						for (let i = 0; i < base64Audio.length; i += MAX_CHUNK_SIZE) {
							chunkNumber++;
							const chunk = base64Audio.slice(i, i + MAX_CHUNK_SIZE);
							const isLast = i + MAX_CHUNK_SIZE >= base64Audio.length;

							socket.emit("audio:chunk", {
								audio: chunk,
								chunkNumber: chunkNumber,
								isLastChunk: isLast,
								totalChunks: Math.ceil(base64Audio.length / MAX_CHUNK_SIZE),
							});

							console.log(
								`Sent chunk ${chunkNumber}/${Math.ceil(
									base64Audio.length / MAX_CHUNK_SIZE
								)}`
							);
						}
					}

					// Clean up
					await FileSystem.deleteAsync(uri, { idempotent: true });
					Alert.alert("Success", "Audio sent successfully");
				}
			} catch (error) {
				console.error("Error processing recording:", error);
				Alert.alert("Error", "Failed to send audio");
			}
		}

		recordingInterval.current = null;
	}

	setRecording(null);
};
