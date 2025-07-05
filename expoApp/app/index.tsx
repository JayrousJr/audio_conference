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

	// Refs
	const recordingInterval = useRef(null);
	const socketRef = useRef(null);
	const isSpeakingRef = useRef(false);
	const chunkNumber = useRef(0);

	// Animations
	const fadeAnim = useRef(new Animated.Value(0)).current;
	const scaleAnim = useRef(new Animated.Value(1)).current;
	const pulseAnim = useRef(new Animated.Value(1)).current;

	// Update ref when isSpeaking changes
	useEffect(() => {
		isSpeakingRef.current = isSpeaking;
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
			}
		} catch (error) {
			console.error("Audio setup error:", error);
		}
	};

	const cleanupResources = () => {
		if (socketRef.current) {
			socketRef.current.disconnect();
		}
		if (recordingInterval.current) {
			clearInterval(recordingInterval.current);
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

		const newSocket = io(serverUrl, {
			transports: ["websocket"],
			reconnection: true,
			reconnectionAttempts: 5,
			reconnectionDelay: 1000,
		});

		socketRef.current = newSocket;

		// Socket event handlers
		newSocket.on("connect", () => {
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

		newSocket.on("disconnect", () => {
			console.log("Disconnected from server");
			setIsConnected(false);
			setIsInQueue(false);
			setIsSpeaking(false);
			stopRecording();
		});

		newSocket.on("connect_error", (error) => {
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
			setIsInQueue(false);
			setIsSpeaking(true);
			Alert.alert("Your Turn", "You can now speak!");
			await startChunkedRecording();
		});

		newSocket.on("user:speaking:end", () => {
			console.log("Speaking ended by server");
			setIsSpeaking(false);
			stopRecording();
			Alert.alert("Speaking Ended", "Your speaking time has ended.");
		});

		newSocket.on("audio:chunk:ack", (data) => {
			console.log("Audio chunk acknowledged:", data);
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

	// NEW: Updated recording with expo-audio
	const startChunkedRecording = async () => {
		try {
			console.log("Starting chunked recording with expo-audio...");
			setRecordingStatus("Initializing...");
			chunkNumber.current = 0;

			// Start the chunked recording loop
			recordChunk();
		} catch (error) {
			console.error("Failed to start chunked recording:", error);
			Alert.alert("Recording Error", error.message);
			setRecordingStatus("Failed to start");
		}
	};

	const recordChunk = async () => {
		if (!isSpeakingRef.current) {
			console.log("Stopping recording - not speaking");
			setRecordingStatus("Stopped");
			return;
		}

		try {
			chunkNumber.current++;
			const currentChunk = chunkNumber.current;

			console.log(`Starting chunk ${currentChunk}`);
			setRecordingStatus(`Recording chunk ${currentChunk}...`);

			// Prepare and start recording
			await audioRecorder.prepareToRecordAsync();
			await audioRecorder.record();

			// Record for 3 seconds
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Stop recording
			console.log(`Stopping chunk ${currentChunk}`);
			await audioRecorder.stop();

			const uri = audioRecorder.uri;
			console.log(`Chunk ${currentChunk} URI:`, uri);

			if (uri) {
				// Get file info and detect format
				const fileInfo = await FileSystem.getInfoAsync(uri);
				const extension = uri.split(".").pop()?.toLowerCase();

				console.log(`Chunk ${currentChunk} info:`, {
					size: fileInfo.size,
					uri: fileInfo.uri,
					extension: extension,
				});

				if (fileInfo.exists && fileInfo.size > 0) {
					// Read as base64
					const base64Audio = await FileSystem.readAsStringAsync(uri, {
						encoding: FileSystem.EncodingType.Base64,
					});

					console.log(
						`Sending chunk ${currentChunk}, base64 length:`,
						base64Audio.length
					);

					// Determine format and MIME type
					let format = "unknown";
					let mimeType = "audio/unknown";

					if (extension === "m4a") {
						format = "m4a";
						mimeType = "audio/mp4";
					} else if (extension === "wav") {
						format = "wav";
						mimeType = "audio/wav";
					} else if (extension === "caf") {
						format = "caf";
						mimeType = "audio/x-caf";
					} else if (extension === "webm") {
						format = "webm";
						mimeType = "audio/webm";
					} else {
						// Default to m4a for HIGH_QUALITY preset
						format = "m4a";
						mimeType = "audio/mp4";
					}

					// Send to server
					if (socketRef.current) {
						socketRef.current.emit("audio:chunk", {
							audio: base64Audio,
							chunkNumber: currentChunk,
							format: format,
							mimeType: mimeType,
							extension: extension,
							size: fileInfo.size,
							timestamp: Date.now(),
						});
					}

					setAudioChunks(currentChunk);
					setRecordingStatus(`Sent chunk ${currentChunk} (${format})`);
				}

				// Cleanup file
				try {
					await FileSystem.deleteAsync(uri, { idempotent: true });
				} catch (e) {
					console.log("File cleanup error:", e);
				}
			}

			// Schedule next chunk if still speaking
			if (isSpeakingRef.current) {
				setTimeout(() => {
					recordChunk();
				}, 100); // Small delay between chunks
			}
		} catch (error) {
			console.error(`Error in chunk ${chunkNumber.current}:`, error);
			setRecordingStatus(`Error: ${error.message}`);

			// Retry after delay if still speaking
			if (isSpeakingRef.current) {
				setTimeout(() => {
					recordChunk();
				}, 2000);
			}
		}
	};

	const stopRecording = async () => {
		console.log("Stop recording called");
		setIsSpeaking(false);
		setAudioChunks(0);
		setRecordingStatus("");
		chunkNumber.current = 0;

		// Stop active recording if any
		try {
			const status = await audioRecorder.getStatusAsync();
			if (status.isRecording) {
				await audioRecorder.stop();
			}
		} catch (error) {
			console.error("Error stopping recording:", error);
		}
	};

	const endSpeaking = () => {
		if (socketRef.current && isSpeaking) {
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
					<Text style={styles.subtitle}>
						Request to speak at the conference
					</Text>
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
								<Text style={styles.buttonText}>Connect to Server</Text>
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
								<Text style={styles.speakingTitle}>🎤 You are speaking!</Text>
								<Text style={styles.speakingSubtitle}>
									Your audio is being transmitted
								</Text>
								<Text style={styles.chunksText}>
									Audio chunks sent: {audioChunks}
								</Text>
								{recordingStatus ? (
									<Text style={styles.statusText}>{recordingStatus}</Text>
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
								<Text style={styles.queueTitle}>You are in queue</Text>
								<Text style={styles.queuePosition}>
									Position: #{queuePosition}
								</Text>
								<Text style={styles.queueInfo}>Please wait for your turn</Text>
							</View>
						) : (
							<Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
								<TouchableOpacity
									style={[styles.button, styles.requestButton]}
									onPress={requestToSpeak}
								>
									<Text style={styles.buttonText}>Request to Speak</Text>
								</TouchableOpacity>
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
	},
	chunksText: {
		fontSize: 14,
		color: "#2c7a7b",
		marginTop: 10,
		marginBottom: 5,
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
	},
});

// Register the app
AppRegistry.registerComponent("main", () => App);

export default App;
