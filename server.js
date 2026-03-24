require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const https = require('https');

// 1. Model Imports
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URI = process.env.DATABASE_URL || "mongodb+srv://newtonmulti_db_user:RPKsmQdCgvlaWCOz@cluster0.khvzewx.mongodb.net/ridewithmeru?retryWrites=true&w=majority";

// Create HTTP server
const server = http.createServer(app);

// --- SECURITY & CORS ---
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

const allowedOrigins = [
    "https://ridewithmeru.surge.sh",
    "https://merurider.surge.sh",
    "https://meruretail.surge.sh",
    "https://ridewithmeru.netlify.app",
    "https://ridewithmeru-riders.netlify.app",
    "https://ridewithmeru.onrender.com",
    "http://localhost:3000",
    "http://127.0.0.1:5500"
];

app.use(cors({ origin: allowedOrigins, credentials: true }));

// --- SOCKET.IO ---
const io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true }
});

// ── IN-MEMORY STORES ──
// Map of riderId  → { socket, name, plate, vehicleType, rating, coords, available }
const onlineRiders = new Map();

// Map of rideId → { customerSocket, riderSocket, payload, status }
const activeRides = new Map();

// Helper: generate a short unique ride ID
function newRideId() {
    return 'RIDE-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
}

io.on('connection', (socket) => {
    console.log(`🔗 Connected: ${socket.id}`);

    // ── ROLE REGISTRATION ──
    // Customers call: socket.emit('join_hub', { role: 'customer' })
    // Riders call:    socket.emit('join_hub', { role: 'rider', ...riderData })
    socket.on('join_hub', (data) => {
        socket.join(data.role);
        socket.userRole = data.role;

        if (data.role === 'rider') {
            // Store rider info so we can match them to requests
            onlineRiders.set(socket.id, {
                socket,
                name:        data.name        || 'Unknown Rider',
                plate:       data.plate       || 'KXX 000X',
                vehicleType: data.vehicleType || 'boda',
                rating:      data.rating      || '4.8',
                trips:       data.trips       || '0',
                phone:       data.phone       || '',
                coords:      data.coords      || null,
                available:   true
            });
            console.log(`🏍️  Rider online: ${data.name} (${data.vehicleType}) — ${socket.id}`);
        } else {
            console.log(`👤 Customer joined — ${socket.id}`);
        }
    });

    // ── RIDER GPS UPDATE (called every 3–5s from rider app) ──
    socket.on('update_location', (data) => {
        // data: { coords: [lat, lng] }
        const rider = onlineRiders.get(socket.id);
        if (rider) {
            rider.coords = data.coords;
            onlineRiders.set(socket.id, rider);
        }

        // If this rider is on an active ride, forward coords to the customer
        activeRides.forEach((ride, rideId) => {
            if (ride.riderSocketId === socket.id && ride.customerSocket) {
                const eta = data.eta || null;
                ride.customerSocket.emit('rider_location', { coords: data.coords, eta });
            }
        });
    });

    // ── CUSTOMER REQUESTS A RIDE ──
    socket.on('request_ride', (payload) => {
        const rideId = newRideId();

        // Store the pending ride keyed to this rideId
        activeRides.set(rideId, {
            customerSocket:   socket,
            customerSocketId: socket.id,
            riderSocket:      null,
            riderSocketId:    null,
            payload,
            status:           'searching'
        });

        console.log(`📡 Ride request [${rideId}] from ${socket.id} — type: ${payload.vehicleType}`);

        // Broadcast to ALL online riders that match the vehicle type
        // (Riders will show an accept/decline UI on their app)
        let dispatched = 0;
        onlineRiders.forEach((rider, riderId) => {
            if (!rider.available) return; // Skip busy riders

            // Match vehicle type (flexible: boda riders accept boda + delivery, taxis accept all taxi types)
            const customerType = (payload.vehicleType || '').toLowerCase();
            const riderType    = (rider.vehicleType   || '').toLowerCase();

            const isMatch =
                riderType === customerType ||
                (customerType.includes('boda') && riderType === 'boda') ||
                (customerType.includes('taxi') && riderType === 'taxi') ||
                (customerType.includes('tuk')  && riderType === 'tuktuk') ||
                (customerType.includes('delivery') && riderType === 'delivery') ||
                (customerType.includes('courier')  && riderType === 'delivery') ||
                (customerType.includes('women') && riderType === 'taxi');  // Female driver flag handled on rider side

            if (isMatch) {
                rider.socket.emit('new_ride_request', {
                    rideId,
                    customerName: payload.customerName || 'Customer',
                    pickup:       payload.pickup,
                    destination:  payload.destination,
                    vehicleType:  payload.vehicleType,
                    fare:         payload.fare,
                    distance:     payload.distance
                });
                dispatched++;
            }
        });

        console.log(`   ↳ Dispatched to ${dispatched} rider(s)`);

        // If zero riders are online, tell the customer immediately
        if (dispatched === 0) {
            socket.emit('no_riders_available', {
                message: 'No riders available right now. Please try again in a few minutes.'
            });
            activeRides.delete(rideId);
        } else {
            // Attach the generated rideId back to the customer so they can cancel
            socket.emit('ride_searching', { rideId });
        }
    });

    // ── RIDER ACCEPTS A RIDE ──
    socket.on('accept_ride', (data) => {
        // data: { rideId }
        const ride = activeRides.get(data.rideId);
        if (!ride || ride.status !== 'searching') return; // Already taken or cancelled

        const rider = onlineRiders.get(socket.id);
        if (!rider) return;

        // Lock the ride to this rider
        ride.riderSocket   = socket;
        ride.riderSocketId = socket.id;
        ride.status        = 'accepted';
        activeRides.set(data.rideId, ride);

        // Mark rider as busy
        rider.available = false;
        onlineRiders.set(socket.id, rider);

        // Tell ALL other riders who got this request to dismiss it
        onlineRiders.forEach((r, rId) => {
            if (rId !== socket.id) {
                r.socket.emit('ride_taken', { rideId: data.rideId });
            }
        });

        // Send full rider profile back to the customer
        ride.customerSocket.emit('rider_found', {
            name:        rider.name,
            initial:     rider.name.charAt(0).toUpperCase(),
            plate:       rider.plate,
            vehicleType: ride.payload.vehicleType,
            rating:      rider.rating,
            trips:       rider.trips,
            phone:       rider.phone,
            coords:      rider.coords || nearbyPoint(ride.payload.pickup.coords),
            eta:         estimateEta(rider.coords, ride.payload.pickup.coords)
        });

        console.log(`✅ Ride [${data.rideId}] accepted by ${rider.name}`);
    });

    // ── RIDER DECLINES A SPECIFIC REQUEST ──
    socket.on('decline_ride', (data) => {
        console.log(`❌ Rider ${socket.id} declined ride [${data.rideId}]`);
        // No state change needed — other riders can still accept
    });

    // ── RIDE STATUS UPDATES (from rider) ──
    // Statuses: 'arrived' | 'started' | 'completed'
    socket.on('ride_status_update', (data) => {
        // data: { rideId, status }
        const ride = activeRides.get(data.rideId);
        if (!ride) return;

        ride.status = data.status;
        activeRides.set(data.rideId, ride);

        // Forward to customer
        if (ride.customerSocket) {
            ride.customerSocket.emit('ride_status', { status: data.status });
        }

        console.log(`🚦 Ride [${data.rideId}] status → ${data.status}`);

        // Clean up completed rides
        if (data.status === 'completed' || data.status === 'cancelled') {
            const rider = onlineRiders.get(ride.riderSocketId);
            if (rider) {
                rider.available = true;
                onlineRiders.set(ride.riderSocketId, rider);
            }
            setTimeout(() => activeRides.delete(data.rideId), 30000);
        }
    });

    // ── CANCEL RIDE (from customer) ──
    socket.on('cancel_ride', (data) => {
        const rideId = data?.rideId;
        if (!rideId) return;

        const ride = activeRides.get(rideId);
        if (!ride) return;

        // Notify rider if they've accepted
        if (ride.riderSocket) {
            ride.riderSocket.emit('ride_cancelled', { rideId, message: 'Customer cancelled the ride.' });
            const rider = onlineRiders.get(ride.riderSocketId);
            if (rider) { rider.available = true; onlineRiders.set(ride.riderSocketId, rider); }
        }

        // Notify all riders who received this request (in case none has accepted yet)
        onlineRiders.forEach(r => r.socket.emit('ride_taken', { rideId }));

        activeRides.delete(rideId);
        console.log(`🚫 Ride [${rideId}] cancelled by customer`);
    });

    // ── CUSTOMER PLACES A FOOD / RETAIL ORDER ──
    socket.on('place_order', (orderData) => {
        io.to('retailer').emit('incoming_order', orderData);
    });

    // ── DISCONNECT ──
    socket.on('disconnect', () => {
        console.log(`❌ Disconnected: ${socket.id}`);

        // If a rider disconnects mid-ride, notify customer
        activeRides.forEach((ride, rideId) => {
            if (ride.riderSocketId === socket.id && ride.customerSocket) {
                ride.customerSocket.emit('ride_status', { status: 'rider_disconnected' });
            }
        });

        onlineRiders.delete(socket.id);
    });
});

// Helper: rough ETA estimate in minutes between two [lat,lng] pairs
function estimateEta(riderCoords, pickupCoords) {
    if (!riderCoords || !pickupCoords) return 4;
    const R = 6371;
    const dLat = (pickupCoords[0] - riderCoords[0]) * Math.PI / 180;
    const dLon = (pickupCoords[1] - riderCoords[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(riderCoords[0]*Math.PI/180) * Math.cos(pickupCoords[0]*Math.PI/180) * Math.sin(dLon/2)**2;
    const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return Math.max(1, Math.round(distKm / 20 * 60)); // Assume 20 km/h avg speed
}

// Helper: generate a coordinate near a base point (fallback when rider has no GPS yet)
function nearbyPoint(base) {
    if (!base) return null;
    return [base[0] + (Math.random() - 0.5) * 0.01, base[1] + (Math.random() - 0.5) * 0.01];
}

// --- DB CONNECTION ---
const DB_OPTIONS = { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 };
mongoose.connect(DB_URI, DB_OPTIONS)
    .then(() => console.log("✅ Meru Database Connected"))
    .catch(err => { console.error("❌ DB Error:", err.message); process.exit(1); });

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    next();
};

// --- STATIC FILES ---
const frontendPath = path.join(__dirname, 'frontend');
app.use(express.static(frontendPath));

// --- SESSION ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'meru_secret_2026',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: DB_URI, collectionName: 'sessions' }),
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        partitioned: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- REST ROUTES ---

app.get('/api/health', (req, res) => res.json({ status: 'ok', riders: onlineRiders.size, rides: activeRides.size }));

// ── NEW: Get currently online riders (for map display) ──
app.get('/api/riders/online', requireAuth, (req, res) => {
    const riders = [];
    onlineRiders.forEach((r, id) => {
        if (r.available && r.coords) {
            riders.push({
                id,
                name:        r.name,
                vehicleType: r.vehicleType,
                rating:      r.rating,
                coords:      r.coords
            });
        }
    });
    res.json({ success: true, riders });
});

// ── NEW: Request a ride via REST (fallback if socket unavailable) ──
app.post('/api/rides/request', requireAuth, async (req, res) => {
    try {
        const { pickup, destination, vehicleType, fare, distance } = req.body;
        const user = await User.findById(req.session.user.id).select('name phone');
        const rideId = newRideId();

        // Store in memory so socket can pick it up
        activeRides.set(rideId, {
            customerSocket:   null,
            customerSocketId: null,
            riderSocket:      null,
            riderSocketId:    null,
            payload:          { customerName: user.name, pickup, destination, vehicleType, fare, distance },
            status:           'searching'
        });

        // Broadcast to riders via socket anyway
        io.to('rider').emit('new_ride_request', {
            rideId,
            customerName: user.name,
            pickup, destination, vehicleType, fare, distance
        });

        res.json({ success: true, rideId });
    } catch(err) {
        res.status(500).json({ success: false, message: 'Could not create ride request.' });
    }
});

// Registration
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, phone, role, vehicleType, plate } = req.body;

        const phoneExists = await User.findOne({ phone });
        if (phoneExists) return res.status(400).json({ success: false, message: "Phone number already registered." });

        if (email) {
            const emailExists = await User.findOne({ email: email.toLowerCase() });
            if (emailExists) return res.status(400).json({ success: false, message: "Email already registered." });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const newUser = new User({
            name,
            email:       email ? email.toLowerCase() : undefined,
            password:    hashedPassword,
            phone,
            role:        role || 'Customer',
            vehicleType,
            plate
        });

        await newUser.save();
        res.status(201).json({ success: true, message: "Account created successfully!" });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, phone, password } = req.body;

        const searchCriteria = [];
        if (email) searchCriteria.push({ email: email.toLowerCase() });
        if (phone) searchCriteria.push({ phone });

        if (searchCriteria.length === 0) {
            return res.status(400).json({ success: false, message: "Provide email or phone number." });
        }

        const user = await User.findOne({ $or: searchCriteria });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }

        req.session.user = { id: user._id, name: user.name, role: user.role };
        req.session.save((err) => {
            if (err) return res.status(500).json({ success: false, message: "Session error." });
            res.json({ success: true, role: user.role });
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// User Data
app.get('/api/user-data', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id).select('-password');
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// Password Reset (unprotected, via phone)
app.patch('/api/auth/direct-reset', async (req, res) => {
    try {
        const { phone, newPassword } = req.body;
        if (!phone || !newPassword) return res.status(400).json({ success: false, message: "Missing data." });

        const hashedPassword = await bcrypt.hash(newPassword, 12);
        const user = await User.findOneAndUpdate({ phone }, { password: hashedPassword }, { new: true });

        if (user) {
            res.json({ success: true, message: "Password updated successfully." });
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
        res.clearCookie('connect.sid', { sameSite: 'none', secure: true, httpOnly: true, partitioned: true });
        res.json({ success: true });
    });
});

// Activity / Transactions
app.get('/api/activity', requireAuth, async (req, res) => {
    try {
        const activities = await Transaction.find({ userId: req.session.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, activities });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load activity." });
    }
});

// Update Profile
app.patch('/api/update-profile', requireAuth, async (req, res) => {
    try {
        const { name, email } = req.body;
        await User.findByIdAndUpdate(req.session.user.id, { name, email });
        req.session.user.name = name;
        res.json({ success: true, message: "Profile updated." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update profile." });
    }
});

// Update Password
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

// Update Preferences
app.patch('/api/update-preferences', requireAuth, async (req, res) => {
    try {
        const { preference, value } = req.body;
        await User.findByIdAndUpdate(req.session.user.id, { $set: { [`preferences.${preference}`]: value } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update preference." });
    }
});

// Clear History
app.delete('/api/clear-history', requireAuth, async (req, res) => {
    try {
        await Transaction.deleteMany({ userId: req.session.user.id });
        res.json({ success: true, message: "History cleared." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to clear history." });
    }
});

// Deactivate Account
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

// Delete Account
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

// Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// --- KEEP-ALIVE PING ---
setInterval(() => {
    https.get('https://ridewithmeru.onrender.com/api/health', (res) => {
        console.log(`Keep-alive: ${res.statusCode} | Riders: ${onlineRiders.size} | Rides: ${activeRides.size}`);
    }).on('error', () => {});
}, 14 * 60 * 1000);

server.listen(PORT, () => console.log(`🚀 RideWithMeru Hub Live on Port ${PORT}`));