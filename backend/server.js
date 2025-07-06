const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Optimized CORS for real-time audio
app.use(
	cors({
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["Content-Type"],
		credentials: true,
	})
);

// Optimized Socket.IO configuration for low-latency audio
const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
	},
	// Optimized for real-time audio streaming
	pingTimeout: 60000,
	pingInterval: 25000,
	upgradeTimeout: 10000,
	maxHttpBufferSize: 2e6, // 2MB for audio packets
	transports: ["websocket"],
	allowUpgrades: true,
});

class OptimizedAudioConference {
	constructor() {
		this.users = new Map();
		this.speakers = new Map();
		this.admins = new Map();
		this.queue = [];
		this.audioStats = new Map();

		// Performance monitoring
		this.totalPacketsProcessed = 0;
		this.averageLatency = 0;
		this.activeConnections = 0;

		console.log("🎵 Optimized Audio Conference Server Started");
		console.log("📊 Performance monitoring enabled");
	}

	// User management
	addUser(socket, userData) {
		const user = {
			id: socket.id,
			socket: socket,
			name: userData.name,
			deviceId: userData.deviceId,
			capabilities: userData.capabilities || {},
			joinTime: Date.now(),
			isAdmin: false,
			isSpeaking: false,
			audioStats: {
				packetsReceived: 0,
				totalBytes: 0,
				averageLatency: 0,
				quality: "good",
			},
		};

		this.users.set(socket.id, user);
		this.activeConnections++;

		// Auto-admin for first user
		if (this.users.size === 1) {
			user.isAdmin = true;
			this.admins.set(socket.id, user);
			socket.emit("admin:promoted");
			console.log(`👑 ${userData.name} is now admin`);
		}

		console.log(`👤 ${userData.name} joined (${this.users.size} total users)`);

		// Send current conference state
		socket.emit("user:joined", {
			success: true,
			isAdmin: user.isAdmin,
			totalUsers: this.users.size,
			queueLength: this.queue.length,
			activeSpeakers: this.speakers.size,
		});

		// Notify others
		this.broadcastToAll("user:list:updated", this.getUserList(), socket.id);
	}

	removeUser(socketId) {
		const user = this.users.get(socketId);
		if (!user) return;

		// Remove from speaking
		if (this.speakers.has(socketId)) {
			this.stopSpeaking(socketId);
		}

		// Remove from queue
		this.queue = this.queue.filter((queueUser) => queueUser.id !== socketId);

		// Remove from admin
		if (this.admins.has(socketId)) {
			this.admins.delete(socketId);
			// Promote next admin if needed
			if (this.admins.size === 0 && this.users.size > 1) {
				this.promoteNextAdmin(socketId);
			}
		}

		this.users.delete(socketId);
		this.audioStats.delete(socketId);
		this.activeConnections--;

		console.log(`👋 ${user.name} left (${this.users.size} total users)`);

		// Update queue positions
		this.updateQueuePositions();
		this.broadcastToAll("user:list:updated", this.getUserList());
	}

	promoteNextAdmin(excludeId) {
		for (const [userId, user] of this.users) {
			if (userId !== excludeId) {
				user.isAdmin = true;
				this.admins.set(userId, user);
				user.socket.emit("admin:promoted");
				console.log(`👑 ${user.name} promoted to admin`);
				break;
			}
		}
	}

	// Speaking queue management
	requestToSpeak(socketId) {
		const user = this.users.get(socketId);
		if (!user) return;

		// Check if already speaking or in queue
		if (this.speakers.has(socketId)) {
			user.socket.emit("error", { message: "You are already speaking" });
			return;
		}

		if (this.queue.find((queueUser) => queueUser.id === socketId)) {
			user.socket.emit("error", { message: "You are already in queue" });
			return;
		}

		// Add to queue
		const queueEntry = {
			id: socketId,
			user: user,
			requestTime: Date.now(),
		};

		this.queue.push(queueEntry);
		this.updateQueuePositions();

		console.log(
			`🎤 ${user.name} requested to speak (Queue position: ${this.queue.length})`
		);

		// Notify admins
		this.broadcastToAdmins("queue:new:request", {
			userId: socketId,
			userName: user.name,
			position: this.queue.length,
			capabilities: user.capabilities,
		});
	}

	approveToSpeak(adminSocketId, userId) {
		const admin = this.admins.get(adminSocketId);
		if (!admin) return false;

		const queueIndex = this.queue.findIndex((entry) => entry.id === userId);
		if (queueIndex === -1) return false;

		const queueEntry = this.queue[queueIndex];
		this.queue.splice(queueIndex, 1);

		this.startSpeaking(userId);
		this.updateQueuePositions();

		console.log(`✅ ${admin.name} approved ${queueEntry.user.name} to speak`);
		return true;
	}

	rejectToSpeak(adminSocketId, userId) {
		const admin = this.admins.get(adminSocketId);
		if (!admin) return false;

		const queueIndex = this.queue.findIndex((entry) => entry.id === userId);
		if (queueIndex === -1) return false;

		const queueEntry = this.queue[queueIndex];
		this.queue.splice(queueIndex, 1);

		queueEntry.user.socket.emit("user:request:rejected", {
			rejectedBy: admin.name,
			timestamp: Date.now(),
		});

		this.updateQueuePositions();

		console.log(`❌ ${admin.name} rejected ${queueEntry.user.name}'s request`);
		return true;
	}

	startSpeaking(socketId) {
		const user = this.users.get(socketId);
		if (!user) return;

		user.isSpeaking = true;
		this.speakers.set(socketId, user);

		// Initialize audio stats for this speaker
		this.audioStats.set(socketId, {
			packetsReceived: 0,
			totalBytes: 0,
			startTime: Date.now(),
			lastPacketTime: Date.now(),
			averageLatency: 0,
			quality: "excellent",
		});

		user.socket.emit("user:speaking:start", {
			startTime: Date.now(),
			optimizedMode: true,
		});

		this.broadcastToAll(
			"speaker:started",
			{
				speakerId: socketId,
				speakerName: user.name,
				timestamp: Date.now(),
			},
			socketId
		);

		console.log(`🎙️ ${user.name} started speaking`);
	}

	stopSpeaking(socketId) {
		const user = this.users.get(socketId);
		if (!user || !this.speakers.has(socketId)) return;

		user.isSpeaking = false;
		const stats = this.audioStats.get(socketId);

		this.speakers.delete(socketId);
		this.audioStats.delete(socketId);

		user.socket.emit("user:speaking:end", {
			endTime: Date.now(),
			sessionStats: stats,
		});

		this.broadcastToAll(
			"speaker:stopped",
			{
				speakerId: socketId,
				speakerName: user.name,
				timestamp: Date.now(),
				sessionStats: stats,
			},
			socketId
		);

		console.log(`🔇 ${user.name} stopped speaking`);
		if (stats) {
			console.log(
				`📊 Session stats: ${stats.packetsReceived} packets, ${(
					stats.totalBytes / 1024
				).toFixed(1)}KB`
			);
		}
	}

	// OPTIMIZED AUDIO PROCESSING - Like WhatsApp
	handleOptimizedAudioPacket(socketId, packetData) {
		const speaker = this.speakers.get(socketId);
		if (!speaker) return;

		const stats = this.audioStats.get(socketId);
		if (!stats) return;

		// Update statistics
		stats.packetsReceived++;
		stats.totalBytes += packetData.size || 0;
		stats.lastPacketTime = Date.now();
		this.totalPacketsProcessed++;

		// Calculate latency
		if (packetData.clientTimestamp) {
			const currentLatency = Date.now() - packetData.clientTimestamp;
			stats.averageLatency =
				stats.averageLatency === 0
					? currentLatency
					: stats.averageLatency * 0.8 + currentLatency * 0.2;

			// Send acknowledgment with latency info
			speaker.socket.emit("audio:packet:ack", {
				packetNumber: packetData.packetNumber,
				serverTimestamp: Date.now(),
				clientTimestamp: packetData.clientTimestamp,
				latency: currentLatency,
				quality: stats.quality,
			});
		}

		// Quality assessment based on packet timing and size
		const expectedSize = 8000; // Approximate size for 200ms AAC audio
		const sizeRatio = packetData.size / expectedSize;

		if (sizeRatio > 0.8 && sizeRatio < 1.2 && stats.averageLatency < 200) {
			stats.quality = "excellent";
		} else if (sizeRatio > 0.6 && stats.averageLatency < 400) {
			stats.quality = "good";
		} else {
			stats.quality = "fair";
		}

		// Optimized broadcasting - immediate transmission
		const optimizedPacket = {
			speakerId: socketId,
			speakerName: speaker.name,
			audio: packetData.audio,
			packetNumber: packetData.packetNumber,
			timestamp: packetData.timestamp,
			serverTimestamp: Date.now(),
			format: packetData.format,
			mimeType: packetData.mimeType,
			size: packetData.size,
			quality: stats.quality,
			isOptimized: true,
			processingTime: packetData.processingTime,
			sampleRate: packetData.sampleRate,
			bitRate: packetData.bitRate,
		};

		// Broadcast to all listeners except the speaker
		let broadcastCount = 0;
		this.users.forEach((user, userId) => {
			if (userId !== socketId && user.socket.connected) {
				user.socket.emit("audio:packet:receive", optimizedPacket);
				broadcastCount++;
			}
		});

		// Performance logging (every 100 packets)
		if (stats.packetsReceived % 100 === 0) {
			console.log(
				`📈 ${speaker.name}: ${
					stats.packetsReceived
				} packets, ${stats.averageLatency.toFixed(0)}ms avg latency, ${
					stats.quality
				} quality`
			);
		}
	}

	handleStreamingStart(socketId, streamData) {
		const speaker = this.speakers.get(socketId);
		if (!speaker) return;

		console.log(
			`🎵 ${speaker.name} started optimized streaming: ${streamData.format} at ${streamData.sampleRate}Hz`
		);

		this.broadcastToAll(
			"streaming:started",
			{
				speakerId: socketId,
				speakerName: speaker.name,
				streamData: streamData,
				timestamp: Date.now(),
			},
			socketId
		);
	}

	handleStreamingEnd(socketId, endData) {
		const speaker = this.speakers.get(socketId);
		if (!speaker) return;

		const stats = this.audioStats.get(socketId);

		console.log(
			`🎵 ${speaker.name} ended streaming: ${endData.totalPackets} packets, ${endData.duration}ms duration`
		);

		this.broadcastToAll(
			"streaming:ended",
			{
				speakerId: socketId,
				speakerName: speaker.name,
				endData: endData,
				sessionStats: stats,
				timestamp: Date.now(),
			},
			socketId
		);
	}

	// Utility methods
	updateQueuePositions() {
		this.queue.forEach((entry, index) => {
			entry.user.socket.emit("user:queued", {
				position: index + 1,
				totalInQueue: this.queue.length,
				estimatedWait: (index + 1) * 2, // Estimate 2 minutes per person
			});
		});

		// Update admins with queue status
		this.broadcastToAdmins("queue:updated", {
			queue: this.queue.map((entry) => ({
				id: entry.id,
				name: entry.user.name,
				requestTime: entry.requestTime,
				capabilities: entry.user.capabilities,
			})),
			totalInQueue: this.queue.length,
		});
	}

	getUserList() {
		return Array.from(this.users.values()).map((user) => ({
			id: user.id,
			name: user.name,
			isAdmin: user.isAdmin,
			isSpeaking: user.isSpeaking,
			joinTime: user.joinTime,
			capabilities: user.capabilities,
		}));
	}

	broadcastToAll(event, data, excludeId = null) {
		this.users.forEach((user, userId) => {
			if (userId !== excludeId && user.socket.connected) {
				user.socket.emit(event, data);
			}
		});
	}

	broadcastToAdmins(event, data) {
		this.admins.forEach((admin) => {
			if (admin.socket.connected) {
				admin.socket.emit(event, data);
			}
		});
	}

	// Performance monitoring
	getPerformanceStats() {
		return {
			totalUsers: this.users.size,
			activeSpeakers: this.speakers.size,
			queueLength: this.queue.length,
			totalPacketsProcessed: this.totalPacketsProcessed,
			averageLatency: this.averageLatency,
			uptime: process.uptime(),
			memoryUsage: process.memoryUsage(),
		};
	}

	// Connection quality monitoring
	handlePing(socket, timestamp) {
		socket.emit("pong", timestamp);
	}
}

const conference = new OptimizedAudioConference();

// Socket.IO event handling
io.on("connection", (socket) => {
	console.log(`🔗 New connection: ${socket.id}`);

	socket.on("user:join", (userData) => {
		conference.addUser(socket, userData);
	});

	socket.on("user:request:speak", (requestData) => {
		conference.requestToSpeak(socket.id);
	});

	socket.on("admin:approve:speak", (data) => {
		conference.approveToSpeak(socket.id, data.userId);
	});

	socket.on("admin:reject:speak", (data) => {
		conference.rejectToSpeak(socket.id, data.userId);
	});

	socket.on("user:speaking:end", () => {
		conference.stopSpeaking(socket.id);
	});

	// OPTIMIZED AUDIO HANDLING
	socket.on("streaming:start", (streamData) => {
		conference.handleStreamingStart(socket.id, streamData);
	});

	socket.on("streaming:end", (endData) => {
		conference.handleStreamingEnd(socket.id, endData);
	});

	// Main audio packet handler - optimized for low latency
	socket.on("audio:packet", (packetData) => {
		conference.handleOptimizedAudioPacket(socket.id, packetData);
	});

	// Legacy support for old chunk method
	socket.on("audio:chunk", (chunkData) => {
		// Convert chunk to packet format
		const packetData = {
			...chunkData,
			packetNumber: chunkData.chunkNumber,
			clientTimestamp: chunkData.timestamp,
		};
		conference.handleOptimizedAudioPacket(socket.id, packetData);
	});

	// Connection quality monitoring
	socket.on("ping", (timestamp) => {
		conference.handlePing(socket, timestamp);
	});

	// Performance monitoring endpoint
	socket.on("stats:request", () => {
		if (conference.admins.has(socket.id)) {
			socket.emit("stats:response", conference.getPerformanceStats());
		}
	});

	socket.on("disconnect", (reason) => {
		console.log(`❌ Disconnected: ${socket.id} (${reason})`);
		conference.removeUser(socket.id);
	});

	socket.on("error", (error) => {
		console.error(`🚨 Socket error for ${socket.id}:`, error);
	});
});

// Health check endpoint
app.get("/health", (req, res) => {
	const stats = conference.getPerformanceStats();
	res.json({
		status: "healthy",
		...stats,
		timestamp: new Date().toISOString(),
	});
});

// Performance monitoring endpoint
app.get("/stats", (req, res) => {
	res.json(conference.getPerformanceStats());
});

app.get("/admin", (req, res) => {
	res.sendFile(path.join(__dirname, "public/admin.html"));
});
app.get("/", (req, res) => {
	const activeSessions = state.streamingSessions.size;
	const activeAdmins = state.admins.size;
	const totalUsers = state.users.size;
	const queueLength = state.queue.length;

	res.send(`
		<html>
			<head>
				<title>Conference Server</title>
				<style>
					body { 
						font-family: Arial, sans-serif; 
						margin: 40px;
						background: #f5f5f5;
					}
					.container {
						max-width: 800px;
						margin: 0 auto;
						background: white;
						padding: 40px;
						border-radius: 12px;
						box-shadow: 0 4px 20px rgba(0,0,0,0.1);
					}
					h1 { 
						color: #333; 
						text-align: center;
						margin-bottom: 30px;
					}
					.status { 
						background: #f8f9fa; 
						padding: 20px; 
						border-radius: 8px; 
						margin: 20px 0; 
						border-left: 4px solid #007bff;
					}
					.metric { 
						margin: 10px 0; 
						font-size: 16px;
					}
					.btn { 
						display: inline-block; 
						padding: 12px 24px; 
						background: #007bff; 
						color: white; 
						text-decoration: none; 
						border-radius: 6px; 
						margin: 10px 5px;
						font-weight: 500;
					}
					.btn:hover {
						background: #0056b3;
					}
				</style>
			</head>
			<body>
				<div class="container">
					<h1>🎵 Conference Server</h1>
					
					<div class="status">
						<h3>📊 Server Status</h3>
						<div class="metric">🟢 Server Online</div>
						<div class="metric">👥 Connected Users: ${totalUsers}</div>
						<div class="metric">📋 Queue Length: ${queueLength}</div>
						<div class="metric">🎤 Active Sessions: ${activeSessions}</div>
						<div class="metric">👨‍💼 Active Admins: ${activeAdmins}</div>
					</div>
					
					<div style="text-align: center; margin-top: 30px;">
						<a href="/admin" class="btn">🎧 Open Admin Panel</a>
					</div>
				</div>
			</body>
		</html>
	`);
});
// Serve basic info
app.get("/api/status", (req, res) => {
	res.json({
		name: "Optimized Audio Conference Server",
		version: "2.0.0",
		description: "WhatsApp-like low-latency audio conferencing",
		features: [
			"Optimized 200ms audio packets",
			"Real-time latency monitoring",
			"Adaptive quality control",
			"Performance analytics",
			"Auto-scaling audio processing",
		],
		stats: conference.getPerformanceStats(),
	});
});

// Performance monitoring - log stats every 30 seconds
setInterval(() => {
	const stats = conference.getPerformanceStats();
	if (stats.totalUsers > 0) {
		console.log(
			`📊 Performance: ${stats.totalUsers} users, ${stats.activeSpeakers} speakers, ${stats.totalPacketsProcessed} packets processed`
		);
	}
}, 30000);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "145.223.98.156";
server.listen(PORT, HOST, () => {
	console.log(`🚀 Optimized Audio Conference Server running on port ${PORT}`);
	console.log(`👨‍💼 Admin panel: http://${HOST}:${PORT}/admin`);
	console.log(`📱 Ready for WhatsApp-like audio streaming!`);
});
