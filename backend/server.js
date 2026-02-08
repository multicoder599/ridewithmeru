const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const User = require('./models/User'); // Ensure this path matches your file structure
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// --- CRITICAL FIX FOR MOBILE LOGIN ---
app.set('trust proxy', 1); // Trust Render's Load Balancer

// Middleware
app.use(express.json());

// Update CORS to allow cookies from any origin (simplified for mobile)
app.use(cors({
    origin: function (origin, callback) {
        callback(null, true); // Allow any frontend to connect
    },
    credentials: true // Allow cookies to travel
}));

// Session Configuration (Mobile Compatible)
app.use(session({
    secret: process.env.SESSION_SECRET || 'merusecretkey',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,      // REQUIRED: Must be true for Render/HTTPS
        sameSite: 'none',  // REQUIRED: Allows cookie to cross from Frontend to Backend
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 Days
    }
}));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// Routes

// 1. REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;
        
        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ success: false, message: "Email already exists" });

        // Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            name, email, phone, role, password: hashedPassword
        });

        await newUser.save();
        res.json({ success: true, message: "Account created successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ success: false, message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: "Invalid credentials" });

        // Save session
        req.session.userId = user._id;
        
        // Manually save session to ensure cookie is set before response
        req.session.save(err => {
            if(err) return res.status(500).json({ success: false, message: "Session Error" });
            res.json({ success: true, message: "Logged in successfully" });
        });

    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 3. GET USER DATA (Session Check)
app.get('/api/user-data', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, message: "Not Authenticated" });
    }

    try {
        const user = await User.findById(req.session.userId).select('-password');
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 4. LOGOUT
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false, message: "Could not log out" });
        res.clearCookie('connect.sid');
        res.json({ success: true, message: "Logged out" });
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));