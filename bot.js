const { Bot, InlineKeyboard } = require("grammy");
const mongoose = require("mongoose");
require("dotenv").config();

const config = require("./config");

const bot = new Bot(process.env.BOT_TOKEN || config.BOT_TOKEN);
const MONGO_URI = process.env.MONGO_URI || config.MONGO_URI;

// MongoDB Connection
mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB successfully!"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// Global variables for managing state
let lastWarningMessage = null; // Stores { chatId, messageId, timer }
const userWarningSessions = new Map(); // Tracks warning setup status per chat
const warningCounts = new Map(); // Tracks warning counts: key "chatId:userId" => count
const muteDurations = new Map(); // Stores mute duration in minutes per chat (default: 5 mins)

// Helper: Delete old warning and set auto-delete timer (5 mins)
async function sendAutoDeleteWarning(ctx, text) {
  if (lastWarningMessage) {
    clearTimeout(lastWarningMessage.timer);
    try {
      await ctx.api.deleteMessage(lastWarningMessage.chatId, lastWarningMessage.messageId);
    } catch (err) {
      // Ignore if message was already deleted
    }
  }

  const sentMsg = await ctx.reply(text);

  const timer = setTimeout(async () => {
    try {
      await ctx.api.deleteMessage(sentMsg.chat.id, sentMsg.message_id);
    } catch (err) {
      // Ignore if message was already deleted
    }
    if (lastWarningMessage && lastWarningMessage.messageId === sentMsg.message_id) {
      lastWarningMessage = null;
    }
  }, 5 * 60 * 1000); // 5 minutes timer

  lastWarningMessage = {
    chatId: sentMsg.chat.id,
    messageId: sentMsg.message_id,
    timer: timer
  };
}

// Inline Keyboards
const startKeyboard = new InlineKeyboard()
  .url("Add to Group", `https://t.me/${bot.botInfo?.username || "MasterRemoverBot"}?startgroup=true`)
  .row()
  .text("Command List", "cmd_list")
  .text("Info", "info_text");

const backKeyboard = new InlineKeyboard()
  .text("Back", "go_back");

// /start Command Handler
bot.command("start", async (ctx) => {
  const welcomeText = "Hello! I am Master Remover Bot. I help manage Telegram groups by automating moderation, tracking warnings, and enforcing temporary mutes.\n\nSelect an option below to learn more:";
  await ctx.reply(welcomeText, { reply_markup: startKeyboard });
});

// /setwarning Command Handler (Stops active warning session)
bot.command("setwarning", async (ctx) => {
  const chatId = ctx.chat.id;
  userWarningSessions.set(chatId, false);
  await ctx.reply("Warning configuration has been updated and saved successfully.");
});

// /setmutetime Command Handler (Admins set custom mute duration in minutes)
bot.command("setmutetime", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.message.text.split(" ");
  const minutes = parseInt(args[1]);

  if (isNaN(minutes) || minutes <= 0) {
    await ctx.reply("Usage: /setmutetime <minutes>\nExample: /setmutetime 10");
    return;
  }

  muteDurations.set(chatId, minutes);
  await ctx.reply(`Mute duration successfully updated to ${minutes} minutes.`);
});

// Callback Queries Handling
bot.callbackQuery("cmd_list", async (ctx) => {
  const commandText = 
`COMMAND LIST AND USAGE

1. Morning Warning Setup
Command: Type 'morning' in chat
Usage: Starts active warning monitoring until /setwarning is executed.

2. Save Warning Configuration
Command: /setwarning
Usage: Saves warning configuration and stops the warning mode.

3. Set Mute Duration
Command: /setmutetime <minutes>
Usage: Sets how long a user stays muted after receiving 3 warnings.
Example: /setmutetime 15

4. Anti-Link Filter [ ON / OFF ]
Command: /antilink [on|off]
Usage: Enables or disables automatic removal of links sent by non-admin members.
Example: /antilink on

5. Bot Remover [ ON / OFF ]
Command: /autoblockbot [on|off]
Usage: Automatically removes newly added bots.
Example: /autoblockbot on

6. Service Message Cleaner [ ON / OFF ]
Command: /cleanjoins [on|off]
Usage: Automatically deletes join/leave notifications.
Example: /cleanjoins on

7. Manual Kick User
Command: /kick [reply or user_id]
Usage: Kicks a member from the group.
Example: /kick @username

8. Manual Ban User
Command: /ban [reply or user_id]
Usage: Bans a member permanently.
Example: /ban @username`;

  await ctx.editMessageText(commandText, { reply_markup: backKeyboard });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("info_text", async (ctx) => {
  const infoText = 
`BOT SYSTEM INFORMATION AND RULES

Overview:
Master Remover is an automated group administration tool designed to maintain clean, orderly, and secure group environments.

Warning & Auto-Mute System Rules:
1. Triggering 'morning' activates the active warning session.
2. During active warning mode, sending messages displays a warning notification along with user message echo.
3. Every warning issued adds to the user's warning count.
4. If a user receives 3 warnings, the bot automatically mutes them for the configured duration (default: 5 minutes).
5. Once the mute duration expires, the user is automatically unmuted and their warning count is reset.
6. All warning messages auto-delete after 5 minutes, or instantly if a new warning message is generated sooner.`;

  await ctx.editMessageText(infoText, { reply_markup: backKeyboard });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("go_back", async (ctx) => {
  const welcomeText = "Hello! I am Master Remover Bot. I help manage Telegram groups by automating moderation, tracking warnings, and enforcing temporary mutes.\n\nSelect an option below to learn more:";
  await ctx.editMessageText(welcomeText, { reply_markup: startKeyboard });
  await ctx.answerCallbackQuery();
});

// Text Messages Listener (Warning, Echo & Auto-Mute Logic)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || "User";

  // Check for 'morning' trigger
  if (text.toLowerCase().includes("morning")) {
    userWarningSessions.set(chatId, true);
    await sendAutoDeleteWarning(ctx, "WARNING: Morning mode initialized. Send /setwarning to complete setup.");
    return;
  }

  // Handle active warning session
  if (userWarningSessions.get(chatId) === true) {
    const key = `${chatId}:${userId}`;
    let count = (warningCounts.get(key) || 0) + 1;
    warningCounts.set(key, count);

    if (count >= 3) {
      const duration = muteDurations.get(chatId) || 5; // Default 5 minutes
      const untilDate = Math.floor(Date.now() / 1000) + (duration * 60);

      try {
        // Mute / Restrict user
        await ctx.restrictChatMember(userId, {
          can_send_messages: false
        }, { until_date: untilDate });

        warningCounts.set(key, 0); // Reset warning count

        const muteNotice = `WARNING LIMIT REACHED: ${userName} has received 3 warnings and has been muted for ${duration} minutes.`;
        await sendAutoDeleteWarning(ctx, muteNotice);
      } catch (err) {
        console.error("Failed to mute member:", err);
        await sendAutoDeleteWarning(ctx, `ERROR: Unable to mute ${userName}. Please ensure the bot is an Admin with permissions to restrict members.`);
      }
    } else {
      const warningNotice = `User Message: "${text}"\n\nWARNING (${count}/3): ${userName}, group warning configuration is active. Send /setwarning to finish setup.`;
      await sendAutoDeleteWarning(ctx, warningNotice);
    }
  }
});

// Global Error Handling
bot.catch((err) => {
  console.error("Error in bot execution:", err);
});

// Start Bot
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot initialized and running as @${botInfo.username}`);
  },
});
