const express = require('express');
const router = express.Router();
const db = require('../config/db');

/**
 * GET /api/resources
 * Query: type, building_code (optional filters)
 * Returns list of all resources (for map + cards).
 */
router.get('/', async (req, res) => {
  try {
    let sql = `
      SELECT r.id, r.name, r.type, r.floor_number, r.description, r.is_open, 
             r.contact_info, r.timings, r.capacity, r.equipment,
             b.code AS building_code, b.name AS building_name, b.location AS building_location
      FROM resources r
      LEFT JOIN buildings b ON r.building_id = b.id
      WHERE 1=1
    `;
    const params = [];

    if (req.query.type) {
      sql += ' AND r.type = ?';
      params.push(req.query.type);
    }
    if (req.query.building_code) {
      sql += ' AND b.code = ?';
      params.push(req.query.building_code);
    }

    sql += ' ORDER BY r.name';

    const [rows] = await db.query(sql, params);
    res.json({ success: true, data: rows || [] });
  } catch (err) {
    console.error('Resources list error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/resources/:id
 * Returns single resource by id (for detail page).
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid resource id.' });
    }

    const [rows] = await db.query(`
      SELECT r.id, r.name, r.type, r.floor_number, r.description, r.is_open, 
             r.contact_info, r.timings, r.capacity, r.equipment,
             b.id AS building_id, b.code AS building_code, b.name AS building_name, 
             b.location AS building_location, b.description AS building_description
      FROM resources r
      LEFT JOIN buildings b ON r.building_id = b.id
      WHERE r.id = ?
    `, [id]);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Resource not found.' });
    }

    const r = rows[0];
    res.json({
      success: true,
      data: {
        id: r.id,
        name: r.name,
        type: r.type,
        building_id: r.building_id,
        building_code: r.building_code,
        building_name: r.building_name,
        building_location: r.building_location,
        floor_number: r.floor_number || '',
        description: r.description || '',
        is_open: Boolean(r.is_open),
        contact_info: r.contact_info || '',
        timings: r.timings || '',
        capacity: r.capacity || null,
        equipment: r.equipment || ''
      }
    });
  } catch (err) {
    console.error('Resource detail error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
