const { Client, Collection, GatewayIntentBits, Partials, REST, Routes, ApplicationCommandOptionType } = require("discord.js");
const { readdirSync } = require("fs");
const { JsonDatabase } = require("five.db");
const { Manager } = require("erela.js");
const Spotify = require("erela.js-spotify");
const path = require("path");

const client = global.client = new Client({
    intents: Object.keys(GatewayIntentBits),
    partials: Object.keys(Partials),
    allowedMentions: { repliedUser: true, parse: ["everyone", "roles", "users"] }
});

const db = client.db = new JsonDatabase();

module.exports = client;

client.commands = new Collection();
client.aliases = new Collection();
client.categories = readdirSync("./commands/");
client.logger = require("./utils/logger.js");
client.config = require("./config.json");
client.prefix = client.config.prefix || "!";

// Manager setup (keep as your original)
client.manager = new Manager({
    nodes: client.config.nodes,
    send: (id, payload) => {
        const guild = client.guilds.cache.get(id);
        if (guild) guild.shard.send(payload);
    },
    autoPlay: true,
    plugins: [new Spotify({
        clientID: client.config.spotifyClientId,
        clientSecret: client.config.spotifyClientSecret
    })]
});

// Load events
readdirSync("./events/Client/").forEach(file => {
    const event = require(`./events/Client/${file}`);
    let eventName = file.split(".")[0];
    console.log(`[CLIENT] Event ${eventName}`);
    client.on(eventName, event.bind(null, client));
});

// Load lavalink events
readdirSync("./events/Lavalink/").forEach(file => {
    const event = require(`./events/Lavalink/${file}`);
    let eventName = file.split(".")[0];
    console.log(`[LAVA] Event ${eventName}`);
    client.manager.on(eventName, event.bind(null, client));
});

// Load commands (keeps original structure)
readdirSync("./commands/").forEach(dir => {
    const commandFiles = readdirSync(`./commands/${dir}/`).filter(f => f.endsWith('.js'));
    for (const file of commandFiles) {
        const command = require(`./commands/${dir}/${file}`);
        if (!command || !command.name) {
            console.warn(`[COMMAND] Skipping invalid command file: ./commands/${dir}/${file}`);
            continue;
        }
        console.log(`[COMMAND] ${command.category} | ${command.name}`);
        client.commands.set(command.name.toLowerCase(), command);

        // register aliases map for quick lookup
        if (Array.isArray(command.aliases)) {
            for (const a of command.aliases) client.aliases.set(a.toLowerCase(), command.name.toLowerCase());
        }
    }
});

// Helper: build slash command data from a command module
function buildSlashDataFromCommand(cmd) {
    try {
        const name = (cmd.name || "").toString().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
        const description = (cmd.description || "No description").toString().slice(0, 100);
        if (!name) return null;

        const data = { name, description, options: [] };

        // If developer provided explicit slashOptions, use them (expects discord API format)
        if (Array.isArray(cmd.slashOptions) && cmd.slashOptions.length) {
            data.options = cmd.slashOptions;
            return data;
        }

        // Auto-add a single "query" string option for commands that expect args
        if (cmd.args) {
            data.options.push({
                name: "query",
                description: cmd.usage ? cmd.usage.replace(/[<>]/g, "") : "Arguments for the command",
                type: ApplicationCommandOptionType.String,
                required: false
            });
        }

        // For commands that clearly take a number (skipto, volume) add better options
        const numCommands = ["skipto", "volume", "seek"];
        if (numCommands.includes(name) && !data.options.length) {
            data.options.push({
                name: "number",
                description: "Number / value",
                type: ApplicationCommandOptionType.String,
                required: true
            });
        }

        return data;
    } catch (err) {
        console.error("buildSlashDataFromCommand error:", err);
        return null;
    }
}

// Register slash commands when ready
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{
            name: `${client.prefix}help`,
            type: 'LISTENING'
        }],
        status: 'online'
    });

    // Build slash commands list from loaded commands
    const slashCommands = [];
    for (const [name, cmd] of client.commands) {
        const data = buildSlashDataFromCommand(cmd);
        if (data) slashCommands.push(data);
    }

    // Use REST to register commands (guild if specified for faster dev; global otherwise)
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN || client.config.token);
    const clientId = client.config.clientId || process.env.CLIENT_ID || client.user.id;
    const guildId = process.env.GUILD_ID || client.config.guildId;

    try {
        if (guildId) {
            console.log(`[SLASH] Registering ${slashCommands.length} commands to guild ${guildId}`);
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: slashCommands }
            );
            console.log("[SLASH] Guild commands registered.");
        } else {
            console.log(`[SLASH] Registering ${slashCommands.length} global commands (may take up to 1 hour to propagate)`);
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: slashCommands }
            );
            console.log("[SLASH] Global commands registered.");
        }
    } catch (err) {
        console.error("[SLASH] Failed to register slash commands:", err);
    }
});

// Export helper used by interaction handler (below file will be created)
client._buildSlashDataFromCommand = buildSlashDataFromCommand;

// login at end to reuse existing token config
client.login(process.env.DISCORD_TOKEN || client.config.token);
