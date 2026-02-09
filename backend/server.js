require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');

// 1. Model Imports
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URI = process.env.DATABASE_URL || "mongodb+srv://newtonmulti_db_user:RPKsmQdCgvlaWCOz@cluster0.khvzewx.mongodb.net/ridewithmeru?retryWrites=true&w=majority";

// --- SECURITY & CORS ---
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1); // Crucial for Render's load balancer

app.use(cors({ 
    // UPDATED: Added Rider and Retailer Netlify URLs to allowed origins
    origin: [
        "https://ridewithmeru.netlify.app", 
        "https://ridewithmeru-riders.netlify.app", 
        "https://ridewithmeru-partners.netlify.app",
        "https://ridewithmeru.onrender.com", 
        "http://localhost:3000",
        "http://127.0.0.1:5500" // Added for local live-server testing
    ], 
    credentials: true // Crucial for sessions/cookies to work on iPhone
}));

// --- DB CONNECTION ---
mongoose.connect(DB_URI)
    .then(() => console.log("✅ Meru Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- PATHING LOGIC ---
const frontendPath = path.join(__dirname, '..', 'frontend');
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
        secure: true,      // Required for HTTPS (Render)
        httpOnly: true,    // Protects against XSS
        sameSite: 'none',  // Required for cross-domain sessions (Safari/iPhone requirement)
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// --- ROUTES ---

// Registration API
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

// Login API
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }
        // Save user to session
        req.session.user = { id: user._id, name: user.name, role: user.role };
        req.session.save(() => res.json({ success: true }));
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// User Data (for Dashboard)
app.get('/api/user-data', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false });
    try {
        const user = await User.findById(req.session.user.id).select('-password');
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- NEW: DIRECT PASSWORD RESET API (NO OTP) ---
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

// Logout API
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ success: false });
        res.clearCookie('connect.sid', { 
            sameSite: 'none', 
            secure: true, 
            httpOnly: true 
        });
        res.json({ success: true });
    });
});

// Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 RideWithMeru Hub Live on Port ${PORT}`));