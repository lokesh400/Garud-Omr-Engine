const express = require('express');
const path = require('path');
const ordinaryRoutes = require('./routes');

const app = express();
const PORT = process.env.ORDINARY_PORT || 3001;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));

// Mount ordinary checking routes
app.use('/ordinary', ordinaryRoutes);
app.get('/', (req, res) => res.redirect('/ordinary'));

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Ordinary OMR Checker] Standalone server running at http://localhost:${PORT}/ordinary`);
        console.log(`[Google Sheets] Zero MongoDB / Zero Cloudinary footprint active.`);
    });
}

module.exports = app;
