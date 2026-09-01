'use strict';

const express = require('express');
const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true, service: 'visisign', time: new Date().toISOString() }));

router.use('/auth', require('./auth.routes'));
router.use('/visits', require('./visits.routes'));
router.use('/reservations', require('./reservations.routes'));
router.use('/kiosk', require('./kiosk.routes'));
router.use('/print', require('./print.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
