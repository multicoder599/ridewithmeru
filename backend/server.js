require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');

// 1. Model Imports
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URI = process.env.DATABASE_URL || "mongodb+srv://newtonmulti_db_user:RPKsmQdCgvlaWCOz@cluster0.khvzewx.mongodb.net/ridewithmeru?retryWrites=true&w=majority";

// --- SECURITY & CORS ---
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

// Configure CORS to allow your live Render URL
app.use(cors({ 
    origin: "https://ridewithmeru.onrender.com", 
    credentials: true 
}));

// --- DB CONNECTION ---
mongoose.connect(DB_URI)
    .then(() => console.log("✅ Meru Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- FIXED PATHING: Sibling Folder Logic ---
// We go up one level from 'backend' to find 'frontend'
const frontendPath = path.join(__dirname, '..', 'frontend');

// DIAGNOSTIC: Check if folder exists on the Render server
if (fs.existsSync(frontendPath)) {
    console.log("📂 Frontend folder found at:", frontendPath);
} else {
    console.log("⚠️ Frontend folder NOT found at:", frontendPath);
    // This logs what the server actually sees to help us troubleshoot
    try {
        console.log("Current parent directory contents:", fs.readdirSync(path.join(__dirname, '..')));
    } catch (e) {
        console.log("Could not read parent directory.");
    }
}

app.use(express.static(frontendPath));

// --- SESSION CONFIG ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'meru_secret_2026',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: DB_URI, collectionName: 'sessions' }),
    cookie: {
        secure: true, // Required for HTTPS on Render
        httpOnly: true,
        sameSite: 'none', // Allows cookies to work across your Render link
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// --- ROUTES ---

// Homepage
app.get('/', (req, res) => {
    const indexPath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("index.html not found in frontend folder.");
    }
});

// SPA Catch-all: For any other route, try serving index.html
app.get('*', (req, res) => {
    const filePath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("Front-end files missing from server.");
    }
});

app.listen(PORT, () => console.log(`🚀 RideWithMeru Hub Live on Port ${PORT}`));