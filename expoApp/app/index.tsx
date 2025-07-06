import React, { useState, useEffect, useRef } from "react";
import { View, StyleSheet, Button, Text, Alert } from "react-native";
import { useAudioRecorder, AudioModule, RecordingPresets } from "expo-audio";
import * as FileSystem from "expo-file-system";
import io from "socket.io-client";

export default function App() {
	// Audio recorder
	const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

	// State
	const [isStreaming, setIsStreaming] = useState(false);
	const [isConnected, setIsConnected] = useState(false);
	const [chunkCount, setChunkCount] = useState(0);
	const [streamingStatus, setStreamingStatus] = useState("Ready");
	const [socket, setSocket] = useState(null);

	// Refs for managing the streaming loop
	const isStreamingRef = useRef(false);
	const chunkNumberRef = useRef(0);
	const socketRef = useRef(null);

	// Connect to server
	useEffect(() => {
		const newSocket = io("http://145.223.98.156:3000", {
			transports: ["websocket"],
		});

		newSocket.on("connect", () => {
			console.log("🔗 Connected to server");
			setIsConnected(true);
			setSocket(newSocket);
			socketRef.current = newSocket;
		});

		newSocket.on("disconnect", () => {
			console.log("❌ Disconnected from server");
			setIsConnected(false);
		});

		newSocket.on("audio:chunk:ack", (data) => {
			console.log("✅ Server acknowledged chunk:", data.chunkNumber);
		});

		return () => {
			newSocket.disconnect();
		};
	}, []);

	// Request permissions
	useEffect(() => {
		(async () => {
			const status = await AudioModule.requestRecordingPermissionsAsync();
			if (!status.granted) {
				Alert.alert("Permission to access microphone was denied");
			} else {
				console.log("✅ Microphone permission granted");
			}
		})();
	}, []);

	// Update ref when streaming state changes
	useEffect(() => {
		isStreamingRef.current = isStreaming;
	}, [isStreaming]);

	const startStreaming = async () => {
		if (!isConnected) {
			Alert.alert("Error", "Not connected to server");
			return;
		}

		try {
			console.log("🎤 Starting real-time audio streaming...");
			setIsStreaming(true);
			setChunkCount(0);
			chunkNumberRef.current = 0;
			setStreamingStatus("Streaming...");

			// Emit streaming start event
			socketRef.current.emit("streaming:start", {
				format: "M4A (AAC)",
				mimeType: "audio/mp4",
				timestamp: Date.now(),
			});

			// Start the chunked recording loop
			recordAndStreamChunk();
		} catch (error) {
			console.error("❌ Failed to start streaming:", error);
			Alert.alert("Streaming Error", error.message);
			setIsStreaming(false);
			setStreamingStatus("Error");
		}
	};

	const recordAndStreamChunk = async () => {
		// Check if we should continue streaming
		if (!isStreamingRef.current) {
			console.log("🛑 Streaming stopped by user");
			setStreamingStatus("Stopped");
			return;
		}

		try {
			chunkNumberRef.current++;
			const currentChunk = chunkNumberRef.current;

			console.log(`🎵 Recording chunk ${currentChunk}...`);
			setStreamingStatus(`Recording chunk ${currentChunk}...`);

			// Prepare and start recording
			await audioRecorder.prepareToRecordAsync();
			await audioRecorder.record();

			// Record for 3 seconds (you can adjust this)
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Stop recording
			await audioRecorder.stop();
			const uri = audioRecorder.uri;

			if (uri) {
				console.log(`📁 Chunk ${currentChunk} recorded:`, uri);

				// Get file info
				const fileInfo = await FileSystem.getInfoAsync(uri);

				if (fileInfo.exists && fileInfo.size > 0) {
					// Read as base64
					const base64Audio = await FileSystem.readAsStringAsync(uri, {
						encoding: FileSystem.EncodingType.Base64,
					});

					// Extract format info
					const extension = uri.split(".").pop()?.toLowerCase();

					console.log(
						`📡 Streaming chunk ${currentChunk} (${(
							fileInfo.size / 1024
						).toFixed(1)}KB)...`
					);
					setStreamingStatus(`Sending chunk ${currentChunk}...`);

					// Send to server
					if (socketRef.current && socketRef.current.connected) {
						socketRef.current.emit("audio:chunk", {
							audio: base64Audio,
							chunkNumber: currentChunk,
							format: extension === "m4a" ? "M4A (AAC)" : extension,
							mimeType: "audio/mp4",
							extension: extension,
							size: fileInfo.size,
							timestamp: Date.now(),
							isStreaming: true, // Flag to indicate this is live streaming
						});

						setChunkCount(currentChunk);
						console.log(`✅ Chunk ${currentChunk} sent to server`);
					} else {
						console.log("❌ Socket not connected, chunk not sent");
					}

					// Cleanup the file
					await FileSystem.deleteAsync(uri, { idempotent: true });
				}
			}

			// Continue with next chunk if still streaming
			if (isStreamingRef.current) {
				// Small delay before next chunk
				setTimeout(() => {
					recordAndStreamChunk();
				}, 200); // 200ms gap between chunks
			}
		} catch (error) {
			console.error(`❌ Error in chunk ${chunkNumberRef.current}:`, error);

			// Try to continue streaming after a short delay
			if (isStreamingRef.current) {
				setTimeout(() => {
					recordAndStreamChunk();
				}, 1000);
			}
		}
	};

	const stopStreaming = async () => {
		console.log("🛑 Stopping streaming...");
		setIsStreaming(false);
		setStreamingStatus("Stopping...");

		// Stop any active recording
		try {
			const status = await audioRecorder.getStatusAsync();
			if (status.isRecording) {
				await audioRecorder.stop();
			}
		} catch (error) {
			console.error("Error stopping recording:", error);
		}

		// Notify server that streaming ended
		if (socketRef.current && socketRef.current.connected) {
			socketRef.current.emit("streaming:end", {
				totalChunks: chunkNumberRef.current,
				timestamp: Date.now(),
			});
		}

		setStreamingStatus("Stopped");
		console.log(
			`✅ Streaming stopped. Total chunks: ${chunkNumberRef.current}`
		);
	};

	const testConnection = () => {
		if (socketRef.current && socketRef.current.connected) {
			socketRef.current.emit("test:ping", {
				message: "Hello from mobile app!",
			});
			console.log("📡 Test ping sent to server");
		} else {
			Alert.alert("Error", "Not connected to server");
		}
	};

	return (
		<View style={styles.container}>
			<Text style={styles.title}>🎵 Live Audio Streaming</Text>

			{/* Connection Status */}
			<View style={styles.section}>
				<Text style={styles.sectionTitle}>📡 Connection</Text>
				<Text style={styles.status}>
					Status: {isConnected ? "✅ Connected" : "❌ Disconnected"}
				</Text>
				<Button
					title="Test Connection"
					onPress={testConnection}
					disabled={!isConnected}
					color="#4299e1"
				/>
			</View>

			{/* Streaming Controls */}
			<View style={styles.section}>
				<Text style={styles.sectionTitle}>🎤 Live Streaming</Text>
				<Text style={styles.info}>Status: {streamingStatus}</Text>
				<Text style={styles.info}>Chunks sent: {chunkCount}</Text>

				<Button
					title={isStreaming ? "⏹️ Stop Streaming" : "🔴 Start Streaming"}
					onPress={isStreaming ? stopStreaming : startStreaming}
					disabled={!isConnected}
					color={isStreaming ? "#e53e3e" : "#48bb78"}
				/>

				{isStreaming && (
					<Text style={styles.streamingText}>
						🔴 LIVE - Your voice is being streamed to the server in real-time!
					</Text>
				)}
			</View>

			{/* Instructions */}
			<View style={styles.section}>
				<Text style={styles.instructions}>
					💡 <Text style={styles.bold}>How it works:</Text>
					{"\n"}• Records 3-second audio chunks continuously{"\n"}• Streams each
					chunk immediately to server{"\n"}• Server can play chunks as they
					arrive{"\n"}• Near real-time audio transmission{"\n"}• Check server
					console for received chunks
				</Text>
			</View>

			{/* Technical Info */}
			<View style={styles.section}>
				<Text style={styles.technicalTitle}>🔧 Technical Details</Text>
				<Text style={styles.technical}>
					Format: M4A (AAC){"\n"}
					MIME: audio/mp4{"\n"}
					Chunk duration: 3 seconds{"\n"}
					Gap between chunks: 200ms{"\n"}
					Encoding: Base64
				</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#f0f2f5",
		padding: 20,
		paddingTop: 50,
	},
	title: {
		fontSize: 24,
		fontWeight: "bold",
		textAlign: "center",
		marginBottom: 30,
		color: "#333",
	},
	section: {
		backgroundColor: "white",
		padding: 20,
		borderRadius: 12,
		marginBottom: 15,
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.1,
		shadowRadius: 4,
		elevation: 3,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 15,
		color: "#333",
	},
	status: {
		fontSize: 16,
		marginBottom: 15,
		color: "#555",
		fontWeight: "500",
	},
	info: {
		fontSize: 14,
		marginBottom: 8,
		color: "#666",
	},
	streamingText: {
		textAlign: "center",
		marginTop: 15,
		fontSize: 16,
		color: "#e53e3e",
		fontWeight: "600",
		backgroundColor: "#fee",
		padding: 10,
		borderRadius: 8,
	},
	instructions: {
		fontSize: 14,
		color: "#666",
		lineHeight: 22,
	},
	bold: {
		fontWeight: "600",
		color: "#333",
	},
	technicalTitle: {
		fontSize: 16,
		fontWeight: "600",
		marginBottom: 10,
		color: "#333",
	},
	technical: {
		fontSize: 12,
		color: "#666",
		lineHeight: 18,
	},
});
