const { Bot, InlineKeyboard } = require("grammy");
const mongoose = require("mongoose");
const config = require("./config");

// ১. MongoDB মড্যুল ও স্কিমা সেটআপ
const groupSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  isVerified: { type: Boolean, default: false },
  linkBlock: { type: Boolean, default: false },
  mentionBlock: { type: Boolean, default: false },
  warningEnabled: { type: Boolean, default: true },
  welcomeEnabled: { type: Boolean, default: true },
  welcomeText: { type: String, default: "Welcome to the group, {name}!" },
  mustJoinChannels: [{ type: String }],
  admins: [{ type: Number }]
});

const Group = mongoose.model("Group", groupSchema);

// ২. ডাটাবেজ কানেকশন
mongoose.connect(config.MONGO_URI)
  .then(() => console.log("Connected to MongoDB successfully!"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// ৩. বট ইনস্ট্যান্স তৈরি
const bot = new Bot(config.BOT_TOKEN);

// হেল্পার ফাংশন: ইউজারের এডমিন স্ট্যাটাস চেক
async function isUserAdmin(ctx, userId) {
  if (config.SUPER_ADMINS.includes(userId)) return true;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch (err) {
    return false;
  }
}

// হেল্পার ফাংশন: গ্রুপ ডেটা পাওয়া বা তৈরি করা
async function getGroupData(chatId) {
  let group = await Group.findOne({ chatId });
  if (!group) {
    group = await Group.create({ chatId });
  }
  return group;
}

// ৪. স্টার্ট কমান্ড ও পিএম কন্ট্রোল
bot.command("start", async (ctx) => {
  if (ctx.chat.type === "private") {
    await ctx.reply(
      "👋 Hello! I am a Telegram Group Management Bot.\nAdd me to your group and make me an admin to manage your community effectively!",
      {
        reply_markup: new InlineKeyboard().url("Add to Group", `https://t.me/${ctx.me.username}?startgroup=true`)
      }
    );
  } else {
    await ctx.reply("Group Management Bot active in this group. Use /settings to configure.");
  }
});

// ৫. অ্যাডমিন কমান্ড: নতুন অ্যাডমিন যুক্ত করা
bot.command("addadmin", async (ctx) => {
  if (!config.SUPER_ADMINS.includes(ctx.from.id)) {
    return ctx.reply("❌ Only Super Admins can use this command.");
  }
  const args = ctx.message.text.split(" ");
  const newAdminId = parseInt(args[1]);
  if (!newAdminId || isNaN(newAdminId)) {
    return ctx.reply("⚠️ Please specify a valid User ID. Example: `/addadmin 123456789`", { parse_mode: "Markdown" });
  }

  const group = await getGroupData(ctx.chat.id);
  if (!group.admins.includes(newAdminId)) {
    group.admins.push(newAdminId);
    await group.save();
    await ctx.reply(`✅ User \`${newAdminId}\` added to bot admins for this group.`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply("⚠️ User is already a bot admin.");
  }
});

// ৬. গ্রুপ ভেরিফিকেশন ও সেটআপ
bot.on("message:new_chat_members", async (ctx) => {
  const isBotAdded = ctx.message.new_chat_members.some((member) => member.id === ctx.me.id);
  
  if (isBotAdded) {
    const keyboard = new InlineKeyboard().callback("Verify Group 🛡️", `verify_group_${ctx.chat.id}`);
    await ctx.reply("Thanks for adding me! Please click below to verify and initialize the group settings.", {
      reply_markup: keyboard
    });
    return;
  }

  // নতুন মেম্বার ওয়েলকাম মেসেজ
  const group = await getGroupData(ctx.chat.id);
  if (group.welcomeEnabled) {
    for (const member of ctx.message.new_chat_members) {
      const msg = group.welcomeText.replace("{name}", member.first_name);
      await ctx.reply(msg);
    }
  }
});

// ভেরিফিকেশন বাটন হ্যান্ডলার
bot.callbackQuery(/^verify_group_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1]);
  const isAdmin = await isUserAdmin(ctx, ctx.from.id);

  if (!isAdmin) {
    return ctx.answerCallbackQuery({ text: "❌ Only group administrators can verify!", show_alert: true });
  }

  const group = await getGroupData(chatId);
  group.isVerified = true;
  await group.save();

  await ctx.answerCallbackQuery({ text: "✅ Group successfully verified!" });
  await ctx.editMessageText("✅ **Group Verified Successfully!** You can now use all moderation features.", { parse_mode: "Markdown" });
});

// ৭. গ্রুপ অপশন টিগল কমান্ডসমূহ (/linkblock, /mentionblock, /warning, /welcome)
bot.command(["linkblock", "mentionblock", "warning", "welcome"], async (ctx) => {
  if (ctx.chat.type === "private") return;
  const isAdmin = await isUserAdmin(ctx, ctx.from.id);
  if (!isAdmin) return ctx.reply("❌ Only administrators can change group settings.");

  const command = ctx.message.text.split(" ")[0].substring(1);
  const arg = ctx.message.text.split(" ")[1];
  const group = await getGroupData(ctx.chat.id);

  if (!["on", "off"].includes(arg)) {
    return ctx.reply(`⚠️ Usage: \`/${command} on\` or \`/${command} off\``, { parse_mode: "Markdown" });
  }

  const status = arg === "on";

  if (command === "linkblock") group.linkBlock = status;
  if (command === "mentionblock") group.mentionBlock = status;
  if (command === "warning") group.warningEnabled = status;
  if (command === "welcome") group.welcomeEnabled = status;

  await group.save();
  await ctx.reply(`⚙️ **${command.toUpperCase()}** has been turned **${arg.toUpperCase()}**.`, { parse_mode: "Markdown" });
});

// ৮. অটোমেটেড স্প্যাম ফিক্সিং ও মেসেজ ফিল্টারিং (Link / Mention Filter)
bot.on("message:text", async (ctx, next) => {
  if (ctx.chat.type === "private") return next();

  const isAdmin = await isUserAdmin(ctx, ctx.from.id);
  if (isAdmin) return next();

  const group = await getGroupData(ctx.chat.id);
  const text = ctx.message.text;

  const hasLink = /(https?:\/\/[^\s]+|t\.me\/[^\s]+)/gi.test(text);
  const hasMention = /@[a-zA-Z0-9_]+/g.test(text);

  let shouldDelete = false;
  let reason = "";

  if (group.linkBlock && hasLink) {
    shouldDelete = true;
    reason = "Links are not allowed in this group.";
  } else if (group.mentionBlock && hasMention) {
    shouldDelete = true;
    reason = "Mentions/Usernames are not allowed in this group.";
  }

  if (shouldDelete) {
    try {
      await ctx.deleteMessage();
      if (group.warningEnabled) {
        const warnMsg = await ctx.reply(`⚠️ [${ctx.from.first_name}](tg://user?id=${ctx.from.id}), ${reason}`, { parse_mode: "Markdown" });
        
        // ৫ মিনিট (৩০০০০০ মিলি-সেকেন্ড) পর অটোমেটিক ওয়ার্নিং মেসেজ ডিলিট হওয়া
        setTimeout(async () => {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, warnMsg.message_id);
          } catch (e) {
            // Ignore error if message was manually deleted
          }
        }, 300000);
      }
    } catch (err) {
      console.error("Failed to delete message:", err);
    }
  } else {
    return next();
  }
});

// ৯. প্রসেস রান
bot.start({
  onStart(botInfo) {
    console.log(`Bot initialized and running as @${botInfo.username}`);
  }
});
