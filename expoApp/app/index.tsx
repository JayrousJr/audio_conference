import React, { useState, useEffect, useRef } from "react";
import {
	SafeAreaView,
	StyleSheet,
	Text,
	View,
	TextInput,
	TouchableOpacity,
	Alert,
	ActivityIndicator,
	Platform,
	KeyboardAvoidingView,
	StatusBar,
	Animated,
	Dimensions,
	AppRegistry,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAudioRecorder, AudioModule, RecordingPresets } from "expo-audio";
import * as FileSystem from "expo-file-system";
import io from "socket.io-client";

const { width } = Dimensions.get("window");

function App() {
	// Audio recorder hook
	const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

	// State
	const [name, setName] = useState("");
	const [serverUrl, setServerUrl] = useState("http://145.223.98.156:3000");
	const [isConnected, setIsConnected] = useState(false);
	const [isInQueue, setIsInQueue] = useState(false);
	const [isSpeaking, setIsSpeaking] = useState(false);
	const [queuePosition, setQueuePosition] = useState(0);
	const [socket, setSocket] = useState(null);
	const [loading, setLoading] = useState(false);
	const [audioChunks, setAudioChunks] = useState(0);
	const [recordingStatus, setRecordingStatus] = useState("");

	// Refs for audio streaming
	const socketRef = useRef(null);
	const isSpeakingRef = useRef(false);
	const chunkNumber = useRef(0);

	// Animations
	const fadeAnim = useRef(new Animated.Value(0)).current;
	const scaleAnim = useRef(new Animated.Value(1)).current;
	const pulseAnim = useRef(new Animated.Value(1)).current;

	// Update ref when speaking state changes
	useEffect(() => {
		isSpeakingRef.current = isSpeaking;
		console.log("🔍 useEffect: isSpeaking changed to:", isSpeaking);
		console.log(
			"🔍 useEffect: isSpeakingRef.current updated to:",
			isSpeakingRef.current
		);
	}, [isSpeaking]);

	// Load saved name on mount
	useEffect(() => {
		loadSavedName();
		setupAudio();

		return () => {
			cleanupResources();
		};
	}, []);

	// Animation for speaking indicator
	useEffect(() => {
		if (isSpeaking) {
			Animated.loop(
				Animated.sequence([
					Animated.timing(pulseAnim, {
						toValue: 1.2,
						duration: 1000,
						useNativeDriver: true,
					}),
					Animated.timing(pulseAnim, {
						toValue: 1,
						duration: 1000,
						useNativeDriver: true,
					}),
				])
			).start();
		} else {
			pulseAnim.setValue(1);
		}
	}, [isSpeaking]);

	const setupAudio = async () => {
		try {
			const status = await AudioModule.requestRecordingPermissionsAsync();
			if (!status.granted) {
				Alert.alert("Permission to access microphone was denied");
			} else {
				console.log("✅ Microphone permission granted");
			}
		} catch (error) {
			console.error("Audio setup error:", error);
		}
	};

	const cleanupResources = () => {
		if (socketRef.current) {
			socketRef.current.disconnect();
		}
		stopRecording();
	};

	const loadSavedName = async () => {
		try {
			const savedName = await AsyncStorage.getItem("userName");
			if (savedName) setName(savedName);
		} catch (error) {
			console.error("Error loading saved name:", error);
		}
	};

	const saveName = async (userName) => {
		try {
			await AsyncStorage.setItem("userName", userName);
		} catch (error) {
			console.error("Error saving name:", error);
		}
	};

	const connectToServer = () => {
		if (!name.trim()) {
			Alert.alert("Error", "Please enter your name");
			return;
		}

		setLoading(true);
		saveName(name);

		console.log("🔗 Attempting to connect to server...");
		const newSocket = io(serverUrl, {
			transports: ["websocket"],
			reconnection: true,
			reconnectionAttempts: 5,
			reconnectionDelay: 1000,
		});

		socketRef.current = newSocket;

		// Socket event handlers
		newSocket.on("connect", () => {
			console.log(
				"🔗 Successfully connected to server, Socket ID:",
				newSocket.id
			);
			setIsConnected(true);
			setLoading(false);
			newSocket.emit("user:join", {
				name: name.trim(),
				deviceId: Platform.OS + "_" + Date.now(),
			});

			Animated.timing(fadeAnim, {
				toValue: 1,
				duration: 500,
				useNativeDriver: true,
			}).start();
		});

		newSocket.on("disconnect", (reason) => {
			console.log("❌ Disconnected from server, reason:", reason);
			setIsConnected(false);
			setIsInQueue(false);
			setIsSpeaking(false);
			stopRecording();
		});

		newSocket.on("connect_error", (error) => {
			console.log("❌ Connection error:", error.message);
			setLoading(false);
			Alert.alert(
				"Connection Error",
				"Could not connect to server. Please check the server URL."
			);
		});

		newSocket.on("user:joined", (data) => {
			console.log("Successfully joined:", data.userId);
		});

		newSocket.on("user:queued", (data) => {
			setIsInQueue(true);
			setQueuePosition(data.position);
			Alert.alert("Success", `You are #${data.position} in the queue`);
		});

		newSocket.on("user:request:rejected", () => {
			setIsInQueue(false);
			Alert.alert(
				"Request Rejected",
				"Your speaking request was rejected by the admin."
			);
		});

		newSocket.on("user:speaking:start", async () => {
			console.log("🎤 Admin approved speaking - starting audio streaming...");
			setIsInQueue(false);
			setIsSpeaking(true);
			Alert.alert(
				"Your Turn",
				"You can now speak! Your audio is being streamed live."
			);
			await startAudioStreaming();
		});

		newSocket.on("user:speaking:end", () => {
			console.log("Speaking ended by server");
			setIsSpeaking(false);
			stopRecording();
			Alert.alert("Speaking Ended", "Your speaking time has ended.");
		});

		newSocket.on("audio:chunk:ack", (data) => {
			console.log("✅ Server acknowledged chunk:", data.chunkNumber);
		});

		newSocket.on("error", (data) => {
			Alert.alert("Error", data.message);
		});

		setSocket(newSocket);
	};

	const requestToSpeak = () => {
		if (!socketRef.current || !isConnected) {
			Alert.alert("Error", "Not connected to server");
			return;
		}

		if (isInQueue || isSpeaking) {
			Alert.alert("Error", "You are already in queue or speaking");
			return;
		}

		console.log("📋 Requesting permission to speak...");
		socketRef.current.emit("user:request:speak");

		Animated.sequence([
			Animated.timing(scaleAnim, {
				toValue: 0.95,
				duration: 100,
				useNativeDriver: true,
			}),
			Animated.timing(scaleAnim, {
				toValue: 1,
				duration: 100,
				useNativeDriver: true,
			}),
		]).start();
	};

	// NEW: Audio streaming functionality integrated
	const startAudioStreaming = async () => {
		try {
			console.log("🎤 Starting audio streaming...");
			setRecordingStatus("Starting streaming...");
			chunkNumber.current = 0;
			setAudioChunks(0);

			// Notify server that streaming started
			socketRef.current.emit("streaming:start", {
				format: "M4A (AAC)",
				mimeType: "audio/mp4",
				timestamp: Date.now(),
			});

			// Start the continuous recording loop
			setTimeout(() => {
				console.log("🚀 Starting recording loop...");
				recordAndStreamChunk();
			}, 100);
		} catch (error) {
			console.error("❌ Failed to start streaming:", error);
			Alert.alert("Streaming Error", error.message);
		}
	};

	const recordAndStreamChunk = async () => {
		// Check if still speaking
		if (!isSpeakingRef.current) {
			console.log("🛑 Streaming stopped - user no longer speaking");
			setRecordingStatus("Stopped");
			return;
		}

		// Check socket connection
		if (!socketRef.current || !socketRef.current.connected) {
			console.log("❌ Socket not connected, cannot stream chunk");
			setRecordingStatus("Connection lost");
			return;
		}

		try {
			chunkNumber.current++;
			const currentChunk = chunkNumber.current;

			console.log(`🎵 Recording chunk ${currentChunk}...`);
			setRecordingStatus(`Recording chunk ${currentChunk}...`);

			// Prepare and start recording
			await audioRecorder.prepareToRecordAsync();
			await audioRecorder.record();

			// Record for 2 seconds
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Check if still speaking before stopping
			if (!isSpeakingRef.current) {
				console.log("🛑 Speaking ended during recording, aborting chunk");
				try {
					await audioRecorder.stop();
				} catch (e) {
					console.log("Error stopping recorder:", e.message);
				}
				return;
			}

			// Stop recording and process
			await audioRecorder.stop();
			const uri = audioRecorder.uri;

			if (uri) {
				const fileInfo = await FileSystem.getInfoAsync(uri);

				if (fileInfo.exists && fileInfo.size > 0) {
					// Read as base64
					const base64Audio = await FileSystem.readAsStringAsync(uri, {
						encoding: FileSystem.EncodingType.Base64,
					});

					const extension = uri.split(".").pop()?.toLowerCase();
					const chunkSizeKB = (fileInfo.size / 1024).toFixed(1);

					console.log(`📡 Sending chunk ${currentChunk} (${chunkSizeKB}KB)`);
					setRecordingStatus(`Sending chunk ${currentChunk}...`);

					// Send to server
					socketRef.current.emit("audio:chunk", {
						audio: base64Audio,
						chunkNumber: currentChunk,
						format: extension === "m4a" ? "M4A (AAC)" : extension,
						mimeType: "audio/mp4",
						extension: extension,
						size: fileInfo.size,
						timestamp: Date.now(),
						isStreaming: true,
						duration: 2000,
					});

					setAudioChunks(currentChunk);
					console.log(`✅ Chunk ${currentChunk} sent to server`);

					// Cleanup file
					await FileSystem.deleteAsync(uri, { idempotent: true });
				}
			}

			// Continue recording if still speaking
			if (isSpeakingRef.current) {
				recordAndStreamChunk();
			}
		} catch (error) {
			console.error(`❌ Error in chunk ${chunkNumber.current}:`, error);
			setRecordingStatus(`Error in chunk ${chunkNumber.current}`);

			// Retry if still speaking
			if (isSpeakingRef.current) {
				setTimeout(() => {
					recordAndStreamChunk();
				}, 1000);
			}
		}
	};

	const stopRecording = async () => {
		console.log("🛑 Stopping audio streaming...");
		setRecordingStatus("");
		setAudioChunks(0);
		chunkNumber.current = 0;

		// Stop active recording
		try {
			await audioRecorder.stop();
		} catch (error) {
			console.log("ℹ️ No active recording to stop");
		}

		// Notify server that streaming ended
		if (socketRef.current && socketRef.current.connected) {
			socketRef.current.emit("streaming:end", {
				totalChunks: chunkNumber.current,
				timestamp: Date.now(),
			});
		}
	};

	const endSpeaking = () => {
		if (socketRef.current && isSpeaking) {
			console.log("🛑 User ending speaking session...");
			socketRef.current.emit("user:speaking:end");
			setIsSpeaking(false);
			stopRecording();
		}
	};

	const disconnect = () => {
		Alert.alert("Disconnect", "Are you sure you want to disconnect?", [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Disconnect",
				style: "destructive",
				onPress: () => {
					cleanupResources();
					setIsConnected(false);
					setIsInQueue(false);
					setIsSpeaking(false);
					setSocket(null);
					socketRef.current = null;
				},
			},
		]);
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar barStyle="light-content" backgroundColor="#667eea" />

			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				style={styles.keyboardView}
			>
				<View style={styles.header}>
					<Text style={styles.title}>Conference Speaker</Text>
					<Text style={styles.subtitle}>Live Audio Conference System</Text>
				</View>

				{!isConnected ? (
					<View style={styles.connectForm}>
						<View style={styles.inputContainer}>
							<Text style={styles.label}>Your Name</Text>
							<TextInput
								style={styles.input}
								placeholder="Enter your full name"
								value={name}
								onChangeText={setName}
								autoCapitalize="words"
								autoCorrect={false}
							/>
						</View>

						<View style={styles.inputContainer}>
							<Text style={styles.label}>Server URL</Text>
							<TextInput
								style={styles.input}
								placeholder="http://server-ip:port"
								value={serverUrl}
								onChangeText={setServerUrl}
								autoCapitalize="none"
								autoCorrect={false}
								keyboardType="url"
							/>
						</View>

						<TouchableOpacity
							style={[styles.button, styles.connectButton]}
							onPress={connectToServer}
							disabled={loading}
						>
							{loading ? (
								<ActivityIndicator color="white" />
							) : (
								<Text style={styles.buttonText}>Connect to Conference</Text>
							)}
						</TouchableOpacity>
					</View>
				) : (
					<Animated.View style={[styles.connectedView, { opacity: fadeAnim }]}>
						<View style={styles.statusCard}>
							<View style={styles.statusRow}>
								<View style={[styles.statusDot, styles.statusDotConnected]} />
								<Text style={styles.statusText}>Connected as {name}</Text>
							</View>
						</View>

						{isSpeaking ? (
							<Animated.View
								style={[
									styles.speakingCard,
									{ transform: [{ scale: pulseAnim }] },
								]}
							>
								<Text style={styles.speakingTitle}>
									🎤 You are speaking LIVE!
								</Text>
								<Text style={styles.speakingSubtitle}>
									Your voice is being streamed to all participants
								</Text>
								<Text style={styles.chunksText}>
									Audio chunks streamed: {audioChunks}
								</Text>
								{recordingStatus ? (
									<Text style={styles.recordingStatus}>{recordingStatus}</Text>
								) : null}
								<TouchableOpacity
									style={[styles.button, styles.endButton]}
									onPress={endSpeaking}
								>
									<Text style={styles.buttonText}>End Speaking</Text>
								</TouchableOpacity>
							</Animated.View>
						) : isInQueue ? (
							<View style={styles.queueCard}>
								<Text style={styles.queueTitle}>⏳ You are in queue</Text>
								<Text style={styles.queuePosition}>
									Position: #{queuePosition}
								</Text>
								<Text style={styles.queueInfo}>
									Please wait for admin approval to speak
								</Text>
							</View>
						) : (
							<Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
								<TouchableOpacity
									style={[styles.button, styles.requestButton]}
									onPress={requestToSpeak}
								>
									<Text style={styles.buttonText}>🎤 Request to Speak</Text>
								</TouchableOpacity>
								<Text style={styles.requestInfo}>
									Admin will approve your request to enable live audio streaming
								</Text>
							</Animated.View>
						)}

						<TouchableOpacity
							style={[styles.button, styles.disconnectButton]}
							onPress={disconnect}
						>
							<Text style={styles.buttonText}>Disconnect</Text>
						</TouchableOpacity>
					</Animated.View>
				)}
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#f0f2f5",
	},
	keyboardView: {
		flex: 1,
	},
	header: {
		backgroundColor: "#667eea",
		paddingVertical: 40,
		paddingHorizontal: 20,
		alignItems: "center",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.1,
		shadowRadius: 8,
		elevation: 5,
	},
	title: {
		fontSize: 28,
		fontWeight: "bold",
		color: "white",
		marginBottom: 8,
	},
	subtitle: {
		fontSize: 16,
		color: "rgba(255,255,255,0.8)",
	},
	connectForm: {
		padding: 20,
		flex: 1,
		justifyContent: "center",
	},
	inputContainer: {
		marginBottom: 20,
	},
	label: {
		fontSize: 16,
		fontWeight: "600",
		color: "#333",
		marginBottom: 8,
	},
	input: {
		backgroundColor: "white",
		borderRadius: 12,
		padding: 16,
		fontSize: 16,
		borderWidth: 1,
		borderColor: "#e0e0e0",
	},
	button: {
		borderRadius: 12,
		padding: 18,
		alignItems: "center",
		marginVertical: 10,
	},
	connectButton: {
		backgroundColor: "#667eea",
		marginTop: 20,
	},
	requestButton: {
		backgroundColor: "#48bb78",
	},
	endButton: {
		backgroundColor: "#e53e3e",
		marginTop: 20,
	},
	disconnectButton: {
		backgroundColor: "#718096",
		marginTop: 30,
	},
	buttonText: {
		color: "white",
		fontSize: 18,
		fontWeight: "600",
	},
	connectedView: {
		flex: 1,
		padding: 20,
		justifyContent: "center",
	},
	statusCard: {
		backgroundColor: "white",
		borderRadius: 12,
		padding: 20,
		marginBottom: 20,
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.05,
		shadowRadius: 8,
		elevation: 3,
	},
	statusRow: {
		flexDirection: "row",
		alignItems: "center",
	},
	statusDot: {
		width: 12,
		height: 12,
		borderRadius: 6,
		marginRight: 10,
	},
	statusDotConnected: {
		backgroundColor: "#48bb78",
	},
	statusText: {
		fontSize: 16,
		color: "#333",
	},
	speakingCard: {
		backgroundColor: "#e6fffa",
		borderRadius: 12,
		padding: 30,
		alignItems: "center",
		borderWidth: 2,
		borderColor: "#4fd1c5",
	},
	speakingTitle: {
		fontSize: 24,
		fontWeight: "bold",
		color: "#234e52",
		marginBottom: 8,
	},
	speakingSubtitle: {
		fontSize: 16,
		color: "#2c7a7b",
		textAlign: "center",
		marginBottom: 15,
	},
	chunksText: {
		fontSize: 14,
		color: "#2c7a7b",
		marginBottom: 5,
	},
	recordingStatus: {
		fontSize: 12,
		color: "#2c7a7b",
		fontStyle: "italic",
		marginBottom: 10,
	},
	queueCard: {
		backgroundColor: "#fef3c7",
		borderRadius: 12,
		padding: 30,
		alignItems: "center",
		borderWidth: 2,
		borderColor: "#f59e0b",
	},
	queueTitle: {
		fontSize: 20,
		fontWeight: "bold",
		color: "#78350f",
		marginBottom: 8,
	},
	queuePosition: {
		fontSize: 36,
		fontWeight: "bold",
		color: "#f59e0b",
		marginBottom: 8,
	},
	queueInfo: {
		fontSize: 16,
		color: "#92400e",
		textAlign: "center",
	},
	requestInfo: {
		fontSize: 14,
		color: "#666",
		textAlign: "center",
		marginTop: 10,
		fontStyle: "italic",
	},
});

// Register the app
AppRegistry.registerComponent("main", () => App);

export default App;
