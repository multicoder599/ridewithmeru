require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http'); // Added for Socket.io
const { Server } = require('socket.io'); // Added for Socket.io

// 1. Model Imports
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URI = process.env.DATABASE_URL || "mongodb+srv://newtonmulti_db_user:RPKsmQdCgvlaWCOz@cluster0.khvzewx.mongodb.net/ridewithmeru?retryWrites=true&w=majority";

// Create HTTP server to wrap the Express app (Required for WebSockets)
const server = http.createServer(app);

// --- SECURITY & CORS ---
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1); // Crucial for Render's load balancer

const allowedOrigins = [
    "https://ridewithmeru.surge.sh", 
    "https://ridewithmeru-riders.surge.sh", 
    "https://ridewithmeru-partners.surge.sh",
    "https://merurider.surge.sh", 
    "https://meruretail.surge.sh",
    "https://ridewithmeru.onrender.com", 
    "http://localhost:3000",
    "http://127.0.0.1:5500"
];

app.use(cors({ 
    origin: allowedOrigins, 
    credentials: true 
}));

// Initialize Socket.io with CORS
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true
    }
});

// --- CONSOLIDATED DB CONNECTION ---
const DB_OPTIONS = {
    serverSelectionTimeoutMS: 5000, 
    connectTimeoutMS: 10000,
};

mongoose.connect(DB_URI, DB_OPTIONS)
    .then(() => console.log("✅ Meru Database Connected"))
    .catch(err => {
        console.error("❌ DB Error:", err.message);
        process.exit(1); // Fail fast if DB doesn't connect
    });

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Auth Guard Middleware for Protected Routes
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    next();
};

// --- PATHING LOGIC ---
const frontendPath = path.join(__dirname, 'frontend');
app.use(express.static(frontendPath));

// --- SESSION CONFIG ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'meru_secret_2026',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ 
        mongoUrl: DB_URI, 
        collectionName: 'sessions' 
    }),
    cookie: {
        secure: true,      
        httpOnly: true,    
        sameSite: 'none',  
        partitioned: true, 
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// --- REAL-TIME SOCKET HUB ---
io.on('connection', (socket) => {
    console.log('🔗 Device connected to Fleet Hub:', socket.id);

    // Join specific rooms (e.g., 'riders', 'retailers', 'customers')
    socket.on('join_hub', (data) => {
        socket.join(data.role);
        console.log(`User joined room: ${data.role}`);
    });

    // Customer places a ride request -> Alert Riders
    socket.on('request_ride', (rideData) => {
        io.to('rider').emit('new_ride_request', rideData);
    });

    // Customer places a food order -> Alert Retailer
    socket.on('place_order', (orderData) => {
        io.to('retailer').emit('incoming_order', orderData);
    });

    socket.on('disconnect', () => {
        console.log('❌ Device disconnected:', socket.id);
    });
});

// --- REST API ROUTES ---

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Registration
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, phone, role } = req.body;
        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: "Email already in use." });

        const hashedPassword = await bcrypt.hash(password, 12);
        const newUser = new User({ 
            name, 
            email: email.toLowerCase(), 
            password: hashedPassword, 
            phone, 
            role: role || 'Customer' 
        });
        await newUser.save();
        res.status(201).json({ success: true, message: "Account created successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, phone, password } = req.body;
        
        const user = await User.findOne({ 
            $or: [
                { email: email ? email.toLowerCase() : null },
                { phone: phone }
            ]
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }
        
        req.session.user = { id: user._id, name: user.name, role: user.role };
        
        req.session.save((err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, role: user.role });
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// User Data (Protected)
app.get('/api/user-data', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id).select('-password');
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// Password Reset (Unprotected, via phone verification)
app.patch('/api/auth/direct-reset', async (req, res) => {
    try {
        const { phone, newPassword } = req.body;
        if (!phone || !newPassword) return res.status(400).json({ success: false, message: "Missing data." });

        const hashedPassword = await bcrypt.hash(newPassword, 12);
        const user = await User.findOneAndUpdate(
            { phone: phone },
            { password: hashedPassword },
            { new: true }
        );

        if (user) {
            res.json({ success: true, message: "Database updated successfully!" });
        } else {
            res.status(404).json({ success: false, message: "No account found with this phone number." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Database update failed." });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ success: false });
        res.clearCookie('connect.sid', { 
            sameSite: 'none', 
            secure: true, 
            httpOnly: true,
            partitioned: true 
        });
        res.json({ success: true });
    });
});

// --- NEW FUNCTIONAL ROUTES (SETTINGS, HISTORY, DANGER ZONE) ---

// Get Activity/Transactions
app.get('/api/activity', requireAuth, async (req, res) => {
    try {
        const activities = await Transaction.find({ userId: req.session.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, activities });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load activity." });
    }
});

// Update Profile Name & Email
app.patch('/api/update-profile', requireAuth, async (req, res) => {
    try {
        const { name, email } = req.body;
        await User.findByIdAndUpdate(req.session.user.id, { name, email });
        req.session.user.name = name; // Sync session
        res.json({ success: true, message: "Profile updated." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update profile." });
    }
});

// Update Password securely
app.patch('/api/update-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const user = await User.findById(req.session.user.id);
        
        if (!(await bcrypt.compare(currentPassword, user.password))) {
            return res.status(400).json({ success: false, message: "Incorrect current password." });
        }
        
        user.password = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.json({ success: true, message: "Password updated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update password." });
    }
});

// Update Notification Preferences
app.patch('/api/update-preferences', requireAuth, async (req, res) => {
    try {
        const { preference, value } = req.body;
        const updateField = `preferences.${preference}`;
        await User.findByIdAndUpdate(req.session.user.id, { $set: { [updateField]: value } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update preference." });
    }
});

// Danger Zone: Clear History
app.delete('/api/clear-history', requireAuth, async (req, res) => {
    try {
        await Transaction.deleteMany({ userId: req.session.user.id });
        res.json({ success: true, message: "History cleared." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to clear history." });
    }
});

// Danger Zone: Deactivate Account
app.patch('/api/deactivate-account', requireAuth, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.session.user.id, { status: 'inactive' });
        req.session.destroy();
        res.clearCookie('connect.sid', { sameSite: 'none', secure: true, httpOnly: true, partitioned: true });
        res.json({ success: true, message: "Account deactivated." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to deactivate account." });
    }
});

// Danger Zone: Delete Account & Data Permanently
app.delete('/api/delete-account', requireAuth, async (req, res) => {
    try {
        await Transaction.deleteMany({ userId: req.session.user.id });
        await User.findByIdAndDelete(req.session.user.id);
        req.session.destroy();
        res.clearCookie('connect.sid', { sameSite: 'none', secure: true, httpOnly: true, partitioned: true });
        res.json({ success: true, message: "Account deleted." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to delete account." });
    }
});

// --- FALLBACK ---
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// --- KEEP-ALIVE PING ---
const https = require('https');
setInterval(() => {
    https.get('https://ridewithmeru.onrender.com/api/health', (res) => {
        console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', () => {});
}, 14 * 60 * 1000); 

// Notice we are using server.listen instead of app.listen now
server.listen(PORT, () => console.log(`🚀 RideWithMeru Hub Live on Port ${PORT}`));