import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { WebSocketServer } from 'ws';

import { Client, GatewayIntentBits } from 'discord.js';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    entersState,
    VoiceConnectionStatus,
    StreamType,
} from '@discordjs/voice';

import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOUND_DIR = path.join(__dirname, 'sounds');
const MAP_FILE = path.join(SOUND_DIR, 'mappings.json');

await fs.mkdir(SOUND_DIR, { recursive: true });

// Load or initialize sound map (name → {filename, emoji})
let soundMap = {};
try {
    const data = await fs.readFile(MAP_FILE, 'utf8');
    soundMap = JSON.parse(data);
} catch {
    soundMap = {};
}

async function saveMap() {
    await fs.writeFile(MAP_FILE, JSON.stringify(soundMap, null, 2));
}

// Setup Express
const app = express();
const port = 3000;

// Multer setup: store files in memory first
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Discord Bot setup
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let player = createAudioPlayer();
let connection = null;
let currentProcess = null;
let isPlaying = false;

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.first();
    if (!guild) {
        console.error('No guilds found');
        return;
    }

    const channel = guild.channels.cache.find(
        (ch) => ch.name === 'new-bot-test' && ch.type === 2
    );

    if (!channel) {
        console.error(`Voice channel 'new-bot-test' not found.`);
        return;
    }

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
        connection.subscribe(player);
        console.log(`🎙️ Joined voice channel '${channel.name}'`);
    } catch (err) {
        console.error('Failed to connect to voice channel:', err);
    }
});

client.login(TOKEN);

// WebSocket setup
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

function broadcastSoundMap() {
    const data = JSON.stringify({ type: 'sounds', sounds: soundMap });
    for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
            client.send(data);
        }
    }
}

wss.on('connection', (ws) => {
    console.log('Client connected via WS');
    ws.send(JSON.stringify({ type: 'sounds', sounds: soundMap }));

    ws.on('close', () => {
        console.log('Client disconnected from WS');
    });
});

// Upload endpoint
app.post('/upload', upload.single('sound'), async (req, res) => {
    const { file } = req;
    const { name, emoji } = req.body;

    if (!file || !name) {
        return res.status(400).json({ error: 'Missing file or name' });
    }

    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname) || '.mp3';
    const filename = id + ext;
    const filepath = path.join(SOUND_DIR, filename);

    try {
        await fs.writeFile(filepath, file.buffer);
    } catch (e) {
        console.error('Failed to save file:', e);
        return res.status(500).json({ error: 'Failed to save file' });
    }

    soundMap[name] = { filename, emoji: emoji || '' };
    await saveMap();
    broadcastSoundMap();

    res.redirect('/');
});

// Get sound mappings
app.get('/mappings', (req, res) => {
    res.json(soundMap);
});

// Play sound endpoint
app.post('/play', async (req, res) => {
    try {
        const { sound, playPressedAt } = req.body;

        const soundData = soundMap[sound];
        if (!soundData) {
            return res.status(404).json({ error: `Sound key '${sound}' not found` });
        }

        const soundPath = path.join(SOUND_DIR, soundData.filename);

        try {
            await fs.stat(soundPath);
        } catch {
            return res.status(404).json({ error: `File '${soundData.filename}' does not exist` });
        }

        if (!connection) {
            return res.status(500).json({ error: 'Bot not connected' });
        }

        const clientTime = Number(playPressedAt);
        const serverReceivedAt = Date.now();

        console.log(`[PLAY REQUEST] Sound key: ${sound} → file: ${soundData.filename}`);
        console.log(` - Client play pressed at: ${clientTime} ms`);
        console.log(` - Server received request at: ${serverReceivedAt} ms`);
        console.log(` - Network + processing delay: ${serverReceivedAt - clientTime} ms`);

        if (isPlaying) {
            await stopCurrentPlayback();
        }

        isPlaying = true;

        currentProcess = spawn(ffmpegPath, [
            '-i', soundPath,
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1',
        ]);

        currentProcess.on('error', (err) => {
            console.error('FFmpeg process error:', err);
            isPlaying = false;
            currentProcess = null;
            player.stop();
        });

        const resource = createAudioResource(currentProcess.stdout, {
            inputType: StreamType.Raw,
        });

        const playStartTime = Date.now();
        console.log(` - Playback started at: ${playStartTime} ms`);
        console.log(` - Total latency (playback start - client press): ${playStartTime - clientTime} ms`);

        player.play(resource);

        player.once(AudioPlayerStatus.Idle, () => {
            console.log(`✅ Finished playing: ${soundData.filename}`);
            currentProcess = null;
            isPlaying = false;
        });

        return res.json({ status: 'Playing' });
    } catch (error) {
        console.error('Error in /play:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Stop playback endpoint
app.post('/stop', async (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
    }
    player.stop();
    isPlaying = false;
    res.json({ status: 'Stopped' });
});

// Cleanup helper
function stopCurrentPlayback() {
    return new Promise((resolve) => {
        if (currentProcess && !currentProcess.killed) {
            currentProcess.kill();
            currentProcess = null;
        }
        if (player.state.status === AudioPlayerStatus.Idle) {
            resolve();
        } else {
            player.once(AudioPlayerStatus.Idle, () => resolve());
            player.stop();
        }
    });
}
