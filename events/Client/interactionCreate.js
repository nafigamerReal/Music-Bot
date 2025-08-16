/**
 * Interaction handler that supports calling existing prefix command modules.
 *
 * Strategy:
 * - For every slash command interaction, find the corresponding command module by name.
 * - Build a "message-like" pseudo message object so existing `execute(message, args, client, prefix)` code works.
 * - Provide message.content so commands that inspect content (e.g., platform detection in play.js)
 *   continue to work when invoked via slash commands.
 *
 * Notes:
 * - If a command module exports `interactionRun(interaction, options, client, prefix)` it will be called directly.
 */

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isChatInputCommand()) return;

        const cmdName = interaction.commandName.toLowerCase();
        const command = client.commands.get(cmdName) || client.commands.get(client.aliases.get(cmdName));
        if (!command) {
            // graceful reply for unknown command
            return interaction.reply({ content: "This command is not available (not loaded).", ephemeral: true });
        }

        // If the command author provided a direct interaction handler, use it
        if (typeof command.interactionRun === "function") {
            try {
                return await command.interactionRun(interaction, interaction.options, client, client.prefix);
            } catch (err) {
                console.error(`Error in command.interactionRun for ${cmdName}:`, err);
                if (!interaction.replied) await interaction.reply({ content: "There was an error running the command.", ephemeral: true });
                return;
            }
        }

        // Build args array from options.
        let args = [];
        // If we added a single "query" option earlier, prefer that
        const queryOpt = interaction.options.getString("query");
        if (queryOpt) {
            args = queryOpt.trim().split(/\s+/);
        } else {
            // Collect all provided options values in order
            const data = interaction.options.data || [];
            for (const opt of data) {
                if (opt.value) args.push(String(opt.value));
            }
        }

        // Build a message-like object that maps commonly used properties/methods
        const pseudoMessage = {
            id: interaction.id,
            createdTimestamp: Date.now(),
            client,
            author: interaction.user,
            member: interaction.member,
            guild: interaction.guild,
            // Minimal "channel" wrapper with .send compatible behavior
            channel: {
                id: interaction.channelId,
                guild: interaction.guild,
                send: async (payload) => {
                    // If it's the first response, reply; else followUp
                    if (!interaction.replied && !interaction.deferred) {
                        // map string -> { content }
                        if (typeof payload === "string") return interaction.reply({ content: payload });
                        // payload may contain embeds, components, files, etc.
                        try {
                            return interaction.reply(payload);
                        } catch (e) {
                            return interaction.followUp(payload);
                        }
                    } else {
                        return interaction.followUp(typeof payload === "string" ? { content: payload } : payload);
                    }
                },
                // pass-through reference for any code expecting raw channel object
                raw: interaction.channel
            },
            reply: async (payload) => {
                if (!interaction.replied && !interaction.deferred) return interaction.reply(typeof payload === "string" ? { content: payload } : payload);
                return interaction.followUp(typeof payload === "string" ? { content: payload } : payload);
            },
            client,
            // Provide content so command files that use message.content work as-is
            content: `${client.prefix}${cmdName} ${args.join(" ")}`.trim()
        };

        // Some existing commands expect message.member.voice etc; interaction.member should be available in guild contexts

        // Validation checks similar to messageCreate event can be added here (args missing, permission checks etc).
        // Keep simple: if command requires args and none provided -> send missing args reply.
        if (command.args && !args.length) {
            const usage = command.usage ? ` ${command.usage}` : "";
            return interaction.reply({ content: `Missing arguments. Usage: \`${client.prefix}${command.name}${usage}\``, ephemeral: true });
        }

        // Execute the command using existing execute(message, args, client, prefix)
        try {
            await command.execute(pseudoMessage, args, client, client.prefix);
            // If the command used message.channel.send it will have replied via our wrapper.
            // If the command didn't respond at all, ensure we at least ack the interaction to avoid timeouts.
            if (!interaction.replied && !interaction.deferred) {
                // Some commands intentionally don't reply (rare), so we only ack if needed.
                // But to be safe, send a small ephemeral confirmation (optional).
                // await interaction.reply({ content: "Command executed.", ephemeral: true });
            }
        } catch (err) {
            console.error(`Error executing command ${cmdName}:`, err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: "An error occurred while running the command.", ephemeral: true });
            }
        }
    } catch (err) {
        console.error("interactionCreate handler error:", err);
    }
};
