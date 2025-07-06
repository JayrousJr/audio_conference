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
	// Audio recorder hook with optimized settings
	const audioRecorder = useAudioRecorder({
		...RecordingPresets.HIGH_QUALITY,
		android: {
			extension: ".m4a",
			outputFormat: "mpeg4",
			audioEncoder: "aac",
			sampleRate: 44100,
			numberOfChannels: 1,
			bitRate: 64000,
		},
		ios: {
			extension: ".m4a",
			outputFormat: "mpeg4",
			audioEncoder: "aac",
			sampleRate: 44100,
			numberOfChannels: 1,
			bitRate: 64000,
		},
	});

	// State
	const [name, setName] = useState("");
	const [serverUrl, setServerUrl] = useState(
		"https://salem-automatically-immediate-train.trycloudflare.com"
	);
	const [isConnected, setIsConnected] = useState(false);
	const [isInQueue, setIsInQueue] = useState(false);
	const [isSpeaking, setIsSpeaking] = useState(false);
	const [queuePosition, setQueuePosition] = useState(0);
	const [loading, setLoading] = useState(false);
	const [audioPackets, setAudioPackets] = useState(0);
	const [connectionQuality, setConnectionQuality] = useState("Good");
	const [audioLatency, setAudioLatency] = useState(0);

	// Refs for optimized audio streaming
	const socketRef = useRef(null);
	const isSpeakingRef = useRef(false);
	const packetNumber = useRef(0);
	const recordingLoopRef = useRef(null);
	const lastPacketTimeRef = useRef(0);
	const connectionTimeRef = useRef(0);

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
		setupOptimizedAudio();
		return () => cleanupResources();
	}, []);

	// Optimized speaking animation
	useEffect(() => {
		if (isSpeaking) {
			Animated.loop(
				Animated.sequence([
					Animated.timing(pulseAnim, {
						toValue: 1.1,
						duration: 600,
						useNativeDriver: true,
					}),
					Animated.timing(pulseAnim, {
						toValue: 1,
						duration: 600,
						useNativeDriver: true,
					}),
				])
			).start();
		} else {
			pulseAnim.setValue(1);
		}
	}, [isSpeaking]);

	const setupOptimizedAudio = async () => {
		try {
			const status = await AudioModule.requestRecordingPermissionsAsync();
			if (!status.granted) {
				Alert.alert(
					"Permission Required",
					"Microphone access is required for voice calls."
				);
			}
		} catch (error) {
			console.error("Audio setup error:", error);
		}
	};

	const cleanupResources = () => {
		if (recordingLoopRef.current) {
			clearTimeout(recordingLoopRef.current);
		}
		if (socketRef.current) {
			socketRef.current.disconnect();
		}
		stopOptimizedRecording();
	};

	const loadSavedName = async () => {
		try {
			const savedName = await AsyncStorage.getItem("userName");
			if (savedName) setName(savedName);
		} catch (error) {
			console.error("Load name error:", error);
		}
	};

	const saveName = async (userName) => {
		try {
			await AsyncStorage.setItem("userName", userName);
		} catch (error) {
			console.error("Save name error:", error);
		}
	};

	const connectToServer = () => {
		if (!name.trim()) {
			Alert.alert("Error", "Please enter your name");
			return;
		}

		setLoading(true);
		saveName(name);
		connectionTimeRef.current = Date.now();

		const newSocket = io(serverUrl, {
			transports: ["websocket"],
			reconnection: true,
			reconnectionAttempts: 5,
			reconnectionDelay: 1000,
			timeout: 5000,
			// Optimized for real-time audio
			upgrade: true,
			forceNew: true,
		});

		socketRef.current = newSocket;

		// Socket event handlers with latency tracking
		newSocket.on("connect", () => {
			const connectTime = Date.now() - connectionTimeRef.current;
			setIsConnected(true);
			setLoading(false);
			setConnectionQuality("Excellent");
			setAudioLatency(connectTime);

			newSocket.emit("user:join", {
				name: name.trim(),
				deviceId: Platform.OS + "_" + Date.now(),
				capabilities: {
					audioCodec: "AAC",
					sampleRate: 44100,
					channels: 1,
					optimized: true,
				},
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
			setConnectionQuality("Disconnected");
			stopOptimizedRecording();
		});

		newSocket.on("connect_error", (error) => {
			setLoading(false);
			setConnectionQuality("Failed");
			Alert.alert(
				"Connection Error",
				"Could not connect to server. Please check your internet connection and server URL."
			);
		});

		newSocket.on("user:joined", (data) => {
			console.log("Successfully joined conference");
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
				"You can now speak. Your voice is being broadcast with optimized quality."
			);
			await startOptimizedAudioStreaming();
		});

		newSocket.on("user:speaking:end", () => {
			setIsSpeaking(false);
			stopOptimizedRecording();
			Alert.alert("Session Ended", "Your speaking session has ended.");
		});

		// Optimized packet acknowledgment with latency measurement
		newSocket.on("audio:packet:ack", (data) => {
			const latency = Date.now() - data.clientTimestamp;
			setAudioLatency(latency);
			setConnectionQuality(
				latency < 100 ? "Excellent" : latency < 200 ? "Good" : "Fair"
			);
		});

		newSocket.on("error", (data) => {
			Alert.alert("Error", data.message);
		});

		// Connection quality monitoring
		const qualityInterval = setInterval(() => {
			if (newSocket.connected) {
				const pingStart = Date.now();
				newSocket.emit("ping", pingStart);
			}
		}, 5000);

		newSocket.on("pong", (pingStart) => {
			const pingTime = Date.now() - pingStart;
			setAudioLatency(pingTime);
			setConnectionQuality(
				pingTime < 50
					? "Excellent"
					: pingTime < 100
					? "Good"
					: pingTime < 200
					? "Fair"
					: "Poor"
			);
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

		socketRef.current.emit("user:request:speak", {
			audioCapabilities: {
				codec: "AAC",
				sampleRate: 44100,
				bitRate: 64000,
				optimized: true,
			},
		});

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

	// OPTIMIZED AUDIO STREAMING - Like WhatsApp
	const startOptimizedAudioStreaming = async () => {
		try {
			packetNumber.current = 0;
			setAudioPackets(0);

			// Notify server with optimized streaming parameters
			socketRef.current.emit("streaming:start", {
				format: "M4A (AAC)",
				mimeType: "audio/mp4",
				sampleRate: 44100,
				bitRate: 64000,
				packetSize: 200, // 200ms packets (vs 1500ms)
				optimized: true,
				timestamp: Date.now(),
			});

			// Start optimized recording loop with minimal delay
			setTimeout(() => {
				recordOptimizedPacket();
			}, 50); // Start almost immediately
		} catch (error) {
			Alert.alert("Audio Error", "Failed to start optimized audio streaming");
		}
	};

	// OPTIMIZED: Smaller packets, faster processing, continuous recording
	const recordOptimizedPacket = async () => {
		if (!isSpeakingRef.current) {
			return;
		}

		if (!socketRef.current || !socketRef.current.connected) {
			setConnectionQuality("Poor");
			// Retry connection
			setTimeout(() => recordOptimizedPacket(), 500);
			return;
		}

		try {
			packetNumber.current++;
			const currentPacket = packetNumber.current;
			const packetStartTime = Date.now();

			// Prepare and start recording
			await audioRecorder.prepareToRecordAsync();
			await audioRecorder.record();

			// OPTIMIZED: Record for only 200ms (vs 1500ms)
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Check if still speaking before stopping
			if (!isSpeakingRef.current) {
				try {
					await audioRecorder.stop();
				} catch (e) {
					console.warn("Stop recording error:", e);
				}
				return;
			}

			// Stop recording and process immediately
			await audioRecorder.stop();
			const uri = audioRecorder.uri;

			if (uri) {
				const fileInfo = await FileSystem.getInfoAsync(uri);

				if (fileInfo.exists && fileInfo.size > 0) {
					// Read as base64 with optimized encoding
					const base64Audio = await FileSystem.readAsStringAsync(uri, {
						encoding: FileSystem.EncodingType.Base64,
					});

					const extension = uri.split(".").pop()?.toLowerCase();
					const packetEndTime = Date.now();
					const processingTime = packetEndTime - packetStartTime;

					// Send optimized packet with metadata
					socketRef.current.emit("audio:packet", {
						audio: base64Audio,
						packetNumber: currentPacket,
						format: extension === "m4a" ? "M4A (AAC)" : extension,
						mimeType: "audio/mp4",
						extension: extension,
						size: fileInfo.size,
						timestamp: packetStartTime,
						processingTime: processingTime,
						isOptimized: true,
						duration: 200, // 200ms packets
						sampleRate: 44100,
						bitRate: 64000,
						clientTimestamp: Date.now(), // For latency measurement
					});

					setAudioPackets(currentPacket);
					setConnectionQuality("Excellent");
					lastPacketTimeRef.current = Date.now();

					// Cleanup file immediately
					await FileSystem.deleteAsync(uri, { idempotent: true });
				}
			}

			// OPTIMIZED: Continue with minimal gap (50ms vs 100ms)
			if (isSpeakingRef.current) {
				recordingLoopRef.current = setTimeout(() => {
					recordOptimizedPacket();
				}, 50); // Faster loop for near real-time streaming
			}
		} catch (error) {
			console.warn("Recording error:", error);
			setConnectionQuality("Fair");

			// Retry with exponential backoff
			if (isSpeakingRef.current) {
				const retryDelay = Math.min(
					200,
					50 * Math.pow(2, packetNumber.current % 4)
				);
				recordingLoopRef.current = setTimeout(() => {
					recordOptimizedPacket();
				}, retryDelay);
			}
		}
	};

	const stopOptimizedRecording = async () => {
		setAudioPackets(0);
		packetNumber.current = 0;

		// Clear the recording loop
		if (recordingLoopRef.current) {
			clearTimeout(recordingLoopRef.current);
			recordingLoopRef.current = null;
		}

		// Stop active recording
		try {
			await audioRecorder.stop();
		} catch (error) {
			console.warn("Stop recording error:", error);
		}

		// Notify server that optimized streaming ended
		if (socketRef.current && socketRef.current.connected) {
			socketRef.current.emit("streaming:end", {
				totalPackets: packetNumber.current,
				duration: packetNumber.current * 200, // 200ms per packet
				optimized: true,
				timestamp: Date.now(),
			});
		}
	};

	const endSpeaking = () => {
		if (socketRef.current && isSpeaking) {
			socketRef.current.emit("user:speaking:end");
			setIsSpeaking(false);
			stopOptimizedRecording();
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
					<Text style={styles.title}>Conference Pro</Text>
					<Text style={styles.subtitle}>Optimized Voice Conference</Text>
					{isConnected && (
						<Text style={styles.connectionInfo}>
							📶 {connectionQuality} • ⚡ {audioLatency}ms • 🎵 AAC 64k
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
							<Text style={styles.label}>Server URL (HTTPS)</Text>
							<TextInput
								style={styles.input}
								placeholder="https://your-cloudflare-url.trycloudflare.com"
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
							<Text style={styles.qualityText}>
								Audio Quality: {connectionQuality} ({audioLatency}ms)
							</Text>
						</View>

						{isSpeaking ? (
							<Animated.View
								style={[
									styles.speakingCard,
									{ transform: [{ scale: pulseAnim }] },
								]}
							>
								<Text style={styles.speakingTitle}>🎤 Live Streaming!</Text>
								<Text style={styles.speakingSubtitle}>
									High-quality audio streaming to all participants
								</Text>
								<View style={styles.statsRow}>
									<Text style={styles.packetsText}>
										Packets: {audioPackets}
									</Text>
									<Text style={styles.latencyText}>
										Latency: ~{audioLatency + 200}ms
									</Text>
								</View>
								<View style={styles.statsRow}>
									<Text style={styles.qualityText}>
										AAC 64k • 44.1kHz • Optimized
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
									Optimized for low-latency voice streaming
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
		marginBottom: 8,
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
		fontWeight: "500",
	},
	qualityText: {
		fontSize: 14,
		color: "#666",
		fontStyle: "italic",
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
	packetsText: {
		fontSize: 14,
		color: "#2c7a7b",
		fontWeight: "500",
	},
	latencyText: {
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
