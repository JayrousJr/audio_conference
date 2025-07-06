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
	AppRegistry,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAudioRecorder, AudioModule, RecordingPresets } from "expo-audio";
import * as FileSystem from "expo-file-system";
import io from "socket.io-client";

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
	const [loading, setLoading] = useState(false);
	const [audioChunks, setAudioChunks] = useState(0);
	const [connectionQuality, setConnectionQuality] = useState("Good");

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
	}, [isSpeaking]);

	// Load saved name on mount
	useEffect(() => {
		loadSavedName();
		setupAudio();
		return () => cleanupResources();
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
				Alert.alert(
					"Permission Required",
					"Microphone access is required for speaking in the conference."
				);
			}
		} catch (error) {
			// Silent error handling in production
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
			// Silent error handling
		}
	};

	const saveName = async (userName) => {
		try {
			await AsyncStorage.setItem("userName", userName);
		} catch (error) {
			// Silent error handling
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
			setConnectionQuality("Excellent");
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
			setIsConnected(false);
			setIsInQueue(false);
			setIsSpeaking(false);
			setConnectionQuality("Poor");
			stopRecording();
		});

		newSocket.on("connect_error", (error) => {
			setLoading(false);
			setConnectionQuality("Failed");
			Alert.alert(
				"Connection Error",
				"Could not connect to server. Please check your internet connection."
			);
		});

		newSocket.on("user:joined", (data) => {
			// User successfully joined
		});

		newSocket.on("user:queued", (data) => {
			setIsInQueue(true);
			setQueuePosition(data.position);
			Alert.alert(
				"Request Sent",
				`You are #${data.position} in the queue. Please wait for admin approval.`
			);
		});

		newSocket.on("user:request:rejected", () => {
			setIsInQueue(false);
			Alert.alert(
				"Request Declined",
				"Your speaking request was declined by the admin."
			);
		});

		newSocket.on("user:speaking:start", async () => {
			setIsInQueue(false);
			setIsSpeaking(true);
			Alert.alert(
				"You're Live!",
				"You can now speak. Your voice is being broadcast live."
			);
			await startAudioStreaming();
		});

		newSocket.on("user:speaking:end", () => {
			setIsSpeaking(false);
			stopRecording();
			Alert.alert("Session Ended", "Your speaking session has ended.");
		});

		newSocket.on("audio:chunk:ack", (data) => {
			// Chunk acknowledged by server
			setConnectionQuality("Excellent");
		});

		newSocket.on("error", (data) => {
			Alert.alert("Error", data.message);
		});
	};

	const requestToSpeak = () => {
		if (!socketRef.current || !isConnected) {
			Alert.alert("Error", "Not connected to server");
			return;
		}

		if (isInQueue || isSpeaking) {
			Alert.alert("Already Active", "You are already in queue or speaking");
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

	// Audio streaming functionality
	const startAudioStreaming = async () => {
		try {
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
				recordAndStreamChunk();
			}, 100);
		} catch (error) {
			Alert.alert("Audio Error", "Failed to start audio streaming");
		}
	};

	const recordAndStreamChunk = async () => {
		// Check if still speaking
		if (!isSpeakingRef.current) {
			return;
		}

		// Check socket connection
		if (!socketRef.current || !socketRef.current.connected) {
			setConnectionQuality("Poor");
			return;
		}

		try {
			chunkNumber.current++;
			const currentChunk = chunkNumber.current;

			// Prepare and start recording
			await audioRecorder.prepareToRecordAsync();
			await audioRecorder.record();

			// Record for 2 seconds
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Check if still speaking before stopping
			if (!isSpeakingRef.current) {
				try {
					await audioRecorder.stop();
				} catch (e) {
					// Silent error handling
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
					setConnectionQuality("Excellent");

					// Cleanup file
					await FileSystem.deleteAsync(uri, { idempotent: true });
				}
			}

			// Continue recording if still speaking
			if (isSpeakingRef.current) {
				recordAndStreamChunk();
			}
		} catch (error) {
			setConnectionQuality("Poor");

			// Retry if still speaking
			if (isSpeakingRef.current) {
				setTimeout(() => {
					recordAndStreamChunk();
				}, 1000);
			}
		}
	};

	const stopRecording = async () => {
		setAudioChunks(0);
		chunkNumber.current = 0;

		// Stop active recording
		try {
			await audioRecorder.stop();
		} catch (error) {
			// Silent error handling
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
			socketRef.current.emit("user:speaking:end");
			setIsSpeaking(false);
			stopRecording();
		}
	};

	const disconnect = () => {
		Alert.alert(
			"Disconnect",
			"Are you sure you want to leave the conference?",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Leave",
					style: "destructive",
					onPress: () => {
						cleanupResources();
						setIsConnected(false);
						setIsInQueue(false);
						setIsSpeaking(false);
						socketRef.current = null;
					},
				},
			]
		);
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar barStyle="light-content" backgroundColor="#667eea" />

			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				style={styles.keyboardView}
			>
				<View style={styles.header}>
					<Text style={styles.title}>Conference</Text>
					<Text style={styles.subtitle}>Live Audio Conference</Text>
					{isConnected && (
						<Text style={styles.connectionInfo}>
							📶 {connectionQuality} Connection
						</Text>
					)}
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
								<Text style={styles.buttonText}>Join Conference</Text>
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
								<Text style={styles.speakingTitle}>🎤 You're Live!</Text>
								<Text style={styles.speakingSubtitle}>
									Speaking to all conference participants
								</Text>
								<View style={styles.statsRow}>
									<Text style={styles.chunksText}>
										Audio: {audioChunks} chunks sent
									</Text>
									<Text style={styles.qualityText}>
										Quality: {connectionQuality}
									</Text>
								</View>
								<TouchableOpacity
									style={[styles.button, styles.endButton]}
									onPress={endSpeaking}
								>
									<Text style={styles.buttonText}>End Speaking</Text>
								</TouchableOpacity>
							</Animated.View>
						) : isInQueue ? (
							<View style={styles.queueCard}>
								<Text style={styles.queueTitle}>⏳ In Queue</Text>
								<Text style={styles.queuePosition}>
									Position #{queuePosition}
								</Text>
								<Text style={styles.queueInfo}>Waiting for admin approval</Text>
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
									Admin will review your request
								</Text>
							</Animated.View>
						)}

						<TouchableOpacity
							style={[styles.button, styles.disconnectButton]}
							onPress={disconnect}
						>
							<Text style={styles.buttonText}>Leave Conference</Text>
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
		fontSize: 32,
		fontWeight: "bold",
		color: "white",
		marginBottom: 8,
	},
	subtitle: {
		fontSize: 16,
		color: "rgba(255,255,255,0.8)",
		marginBottom: 5,
	},
	connectionInfo: {
		fontSize: 14,
		color: "rgba(255,255,255,0.9)",
		fontWeight: "500",
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
		fontSize: 28,
		fontWeight: "bold",
		color: "#234e52",
		marginBottom: 8,
	},
	speakingSubtitle: {
		fontSize: 16,
		color: "#2c7a7b",
		textAlign: "center",
		marginBottom: 20,
	},
	statsRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		width: "100%",
		marginBottom: 15,
	},
	chunksText: {
		fontSize: 14,
		color: "#2c7a7b",
		fontWeight: "500",
	},
	qualityText: {
		fontSize: 14,
		color: "#2c7a7b",
		fontWeight: "500",
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
		fontSize: 24,
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

AppRegistry.registerComponent("main", () => App);
export default App;
