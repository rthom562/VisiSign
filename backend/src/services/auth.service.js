'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const repo = require('../repositories/repo');
const config = require('../config');
const { ApiError } = require('../utils/http');
const { publicId } = require('../utils/ids');

function signToken(user) {
  return jwt.sign(
    { sub: user.public_id, role: user.role, level: user.access_level, name: user.full_name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

// The login identifier is a plain username — it does NOT have to be an email.
// (It is stored in the users.email column for backwards compatibility, but any
// string works: "root", "reception", "jane", or an email address.)
function publicUser(u) {
  return {
    id: u.public_id,
    username: u.email,
    email: u.email, // kept for backwards compatibility
    fullName: u.full_name,
    role: u.role,
    accessLevel: u.access_level,
    isActive: !!u.is_active,
  };
}

async function login(username, password) {
  const user = repo.users.byEmail(String(username || '').toLowerCase().trim());
  // Always run a hash compare to avoid leaking which usernames exist (timing).
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv';
  const valid = await bcrypt.compare(String(password || ''), hash);
  if (!user || !valid) throw new ApiError(401, 'Invalid username or password', 'bad_credentials');
  if (!user.is_active) throw new ApiError(403, 'Account is disabled', 'disabled');
  return { token: signToken(user), user: publicUser(user) };
}

// Creates a user (+ role profile row). Used by seed and admin user management.
// Accepts `username` (preferred) or `email` as the login identifier.
async function createUser({ username, email, password, fullName, role, accessLevel, profile = {} }) {
  const login = String(username ?? email ?? '').toLowerCase().trim();
  if (!login || !password || !fullName) throw new ApiError(400, 'username, password and fullName are required');
  if (!['staff', 'admin'].includes(role)) throw new ApiError(400, 'role must be staff or admin');
  if (repo.users.byEmail(login)) throw new ApiError(409, 'That username is already taken', 'duplicate');

  const password_hash = await bcrypt.hash(String(password), 10);
  const pid = publicId('usr');

  const created = repo.tx(() => {
    const res = repo.users.create({
      public_id: pid,
      email: login,
      password_hash,
      full_name: fullName,
      role,
      access_level: accessLevel ?? (role === 'admin' ? 5 : 1),
    });
    const userId = res.lastInsertRowid;
    if (role === 'staff') repo.staff.create({ user_id: userId, ...profile });
    if (role === 'admin') repo.admins.create({ user_id: userId, scope: profile.scope || 'global' });
    return repo.users.byId(userId);
  })();

  return publicUser(created);
}

module.exports = { login, createUser, publicUser, signToken };
