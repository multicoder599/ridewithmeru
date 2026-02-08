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
    // ADD YOUR NETLIFY URL HERE
    origin: ["https://ridewithmeru.netlify.app", "https://ridewithmeru.onrender.com", "http://localhost:3000"], 
    credentials: true // Crucial for sessions/cookies
}));

// --- DB CONNECTION ---
mongoose.connect(DB_URI)
    .then(() => console.log("✅ Meru Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- PATHING LOGIC ---
// This remains for local testing or if you use Render to serve some assets
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
        secure: true,      // Required for HTTPS
        httpOnly: true,    // Protects against XSS
        sameSite: 'none',  // Required for cross-domain sessions
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

// Logout API
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ success: false });
        res.clearCookie('connect.sid', { sameSite: 'none', secure: true });
        res.json({ success: true });
    });
});

// Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 RideWithMeru Hub Live on Port ${PORT}`));