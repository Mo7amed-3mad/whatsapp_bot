// بوت واتساب محسّن ومتكامل
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// تخزين حالة اللعبة
const xoGames = {};
// تخزين أعضاء المجموعات
const groupMembers = {};
// قائمة المشرفين المخولين للمنشن الجماعي
const authorizedUsers = {};
// إعدادات المجموعات
const groupSettings = {};
// إحصائيات المستخدمين
const userStats = {};
// رسائل ترحيب مخصصة
const welcomeMessages = {};

// قراءة البيانات المحفوظة
function loadData() {
    try {
        if (fs.existsSync('bot_data.json')) {
            const data = JSON.parse(fs.readFileSync('bot_data.json', 'utf8'));
            Object.assign(authorizedUsers, data.authorizedUsers || {});
            Object.assign(groupSettings, data.groupSettings || {});
            Object.assign(userStats, data.userStats || {});
            Object.assign(welcomeMessages, data.welcomeMessages || {});
        }
    } catch (error) {
        console.error('خطأ في قراءة البيانات:', error);
    }
}

// حفظ البيانات
function saveData() {
    try {
        const data = {
            authorizedUsers,
            groupSettings,
            userStats,
            welcomeMessages
        };
        fs.writeFileSync('bot_data.json', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('خطأ في حفظ البيانات:', error);
    }
}

async function startBot() {
    // تحميل البيانات المحفوظة
    loadData();
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('امسح رمز QR التالي باستخدام تطبيق واتساب:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom && 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut);
                
            console.log('اتصال مغلق بسبب: ', lastDisconnect.error);
            
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ تم فتح الاتصال بنجاح! البوت جاهز للعمل.');
        }
    });
    
    sock.ev.on('group-participants.update', async (event) => {
        const { id, participants, action } = event;
        
        await updateGroupMembers(sock, id);
        
        if (action === 'add') {
            // ترحيب مخصص بالأعضاء الجدد
            const customWelcome = welcomeMessages[id];
            let welcomeMsg = customWelcome || `🎉 مرحباً بك في المجموعة!\n\nنتمنى لك إقامة طيبة معنا 😊`;
            
            for (const participant of participants) {
                welcomeMsg += `\n@${participant.split('@')[0]}`;
                
                // تحديث إحصائيات المستخدم
                updateUserStats(participant, 'joined_groups');
            }
            
            await sock.sendMessage(id, {
                text: welcomeMsg,
                mentions: participants
            });
        } else if (action === 'remove') {
            // رسالة وداع
            for (const participant of participants) {
                const userName = participant.split('@')[0];
                await sock.sendMessage(id, {
                    text: `👋 وداعاً ${userName}، نتمنى لك التوفيق!`
                });
            }
        }
    });
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const message of messages) {
            try {
                await handleMessage(sock, message);
            } catch (error) {
                console.error('خطأ في معالجة الرسالة:', error);
            }
        }
    });
    
    // حفظ البيانات كل 5 دقائق
    setInterval(saveData, 5 * 60 * 1000);
}

// تحديث إحصائيات المستخدم
function updateUserStats(userId, action) {
    if (!userStats[userId]) {
        userStats[userId] = {
            messages: 0,
            commands: 0,
            games_played: 0,
            joined_groups: 0,
            last_activity: Date.now()
        };
    }
    
    if (action === 'message') userStats[userId].messages++;
    else if (action === 'command') userStats[userId].commands++;
    else if (action === 'game') userStats[userId].games_played++;
    else if (action === 'joined_groups') userStats[userId].joined_groups++;
    
    userStats[userId].last_activity = Date.now();
}

async function updateGroupMembers(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        groupMembers[groupId] = metadata.participants;
        
        // تهيئة إعدادات المجموعة إذا لم تكن موجودة
        if (!groupSettings[groupId]) {
            groupSettings[groupId] = {
                name: metadata.subject,
                description: metadata.desc || '',
                created: metadata.creation,
                welcome_enabled: true,
                auto_delete: false,
                word_filter: []
            };
        }
    } catch (error) {
        console.error('خطأ في تحديث أعضاء المجموعة:', error);
    }
}

async function handleMessage(sock, message) {
    if (!message.message) return;
    
    const messageType = Object.keys(message.message)[0];
    const chatId = message.key.remoteJid;
    let body = '';
    
    if (messageType === 'conversation') {
        body = message.message.conversation;
    } else if (messageType === 'extendedTextMessage') {
        body = message.message.extendedTextMessage.text;
    } else {
        return;
    }
    
    if (message.key.fromMe) return;
    
    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    
    if (isGroup && !groupMembers[chatId]) {
        await updateGroupMembers(sock, chatId);
    }
    
    // تحديث إحصائيات المستخدم
    updateUserStats(sender, 'message');
    
    console.log(`📥 رسالة من ${sender.split('@')[0]} في ${isGroup ? 'مجموعة' : 'محادثة خاصة'}: ${body}`);
    
    // معالجة الأوامر
    if (body.startsWith('!')) {
        updateUserStats(sender, 'command');
        const [command, ...args] = body.slice(1).trim().split(' ');
        
        switch (command.toLowerCase()) {
            case 'مرحبا':
            case 'hi':
                await sock.sendMessage(chatId, { 
                    text: `👋 مرحباً ${sender.split('@')[0]}!\n\nأنا بوت واتساب متطور جاهز للمساعدة.\nاستخدم !مساعدة لرؤية جميع الأوامر المتاحة.` 
                });
                break;
                
            case 'منشن':
                if (isGroup) {
                    const messageToSend = args.join(' ');
                    await mentionAll(sock, chatId, sender, messageToSend);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'منشن_عشوائي':
            case 'random':
                if (isGroup) {
                    const messageToSend = args.join(' ');
                    await randomMention(sock, chatId, sender, messageToSend);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'ترقية':
            case 'promote':
                if (isGroup) {
                    const targetUser = message.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    await promoteUser(sock, chatId, sender, targetUser);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'تنزيل':
            case 'demote':
                if (isGroup) {
                    const targetUser = message.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    await demoteUser(sock, chatId, sender, targetUser);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'طرد':
            case 'kick':
                if (isGroup) {
                    const targetUser = message.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    await kickMember(sock, chatId, sender, targetUser);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'لعبة':
            case 'xo':
                if (isGroup) {
                    await startXOGame(sock, chatId, sender);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'انضمام':
            case 'join':
                if (isGroup && xoGames[chatId]) {
                    await joinXOGame(sock, chatId, sender);
                }
                break;
                
            case 'اختيار':
            case 'play':
                if (isGroup) {
                    const position = parseInt(args[0]);
                    if (!isNaN(position) && position >= 1 && position <= 9) {
                        await playXO(sock, chatId, sender, position);
                    } else {
                        await sock.sendMessage(chatId, { text: '❌ يرجى تحديد موقع صحيح (1-9).' });
                    }
                }
                break;
                
            case 'معلومات':
            case 'info':
                if (isGroup) {
                    await getGroupInfo(sock, chatId);
                } else {
                    await getUserInfo(sock, chatId, sender);
                }
                break;
                
            case 'احصائياتي':
            case 'mystats':
                await getUserStats(sock, chatId, sender);
                break;
                
            case 'ترحيب':
            case 'welcome':
                if (isGroup) {
                    const welcomeMsg = args.join(' ');
                    await setWelcomeMessage(sock, chatId, sender, welcomeMsg);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'حذف':
            case 'delete':
                if (isGroup) {
                    await deleteMessages(sock, chatId, sender, parseInt(args[0]) || 1);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'قرعة':
            case 'lottery':
                if (isGroup) {
                    await groupLottery(sock, chatId, sender);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'تصويت':
            case 'poll':
                if (isGroup) {
                    const question = args.join(' ');
                    await createPoll(sock, chatId, sender, question);
                } else {
                    await sock.sendMessage(chatId, { text: '❌ هذا الأمر متاح فقط في المجموعات.' });
                }
                break;
                
            case 'حكمة':
            case 'wisdom':
                await sendWisdom(sock, chatId);
                break;
                
            case 'مساعدة':
            case 'help':
                await sendHelpMessage(sock, chatId, isGroup);
                break;
                
            default:
                await sock.sendMessage(chatId, { 
                    text: `❓ أمر غير معروف: "${command}"\nاستخدم !مساعدة للحصول على قائمة الأوامر المتاحة.` 
                });
        }
    }
}

// وظيفة المنشن الجماعي (للمخولين فقط)
async function mentionAll(sock, groupId, sender, message = '') {
    try {
        // التحقق من الصلاحيات
        if (!isAuthorized(groupId, sender)) {
            await sock.sendMessage(groupId, { 
                text: '❌ ليس لديك صلاحية لاستخدام المنشن الجماعي.\nيمكن للمشرفين ترقيتك باستخدام !ترقية @اسمك' 
            });
            return;
        }
        
        const members = groupMembers[groupId];
        if (!members || members.length === 0) {
            await sock.sendMessage(groupId, { text: '❌ لا يمكن العثور على أعضاء المجموعة.' });
            return;
        }
        
        const mentions = members.map(member => member.id);
        let mentionText = message || '📢 إعلان عام للجميع';
        mentionText += '\n\n👥 ';
        
        for (const member of members) {
            if (member.id !== sender) {
                mentionText += `@${member.id.split('@')[0]} `;
            }
        }
        
        mentionText += '\n\n⏰ ' + new Date().toLocaleString('ar-SA');
        
        await sock.sendMessage(groupId, {
            text: mentionText,
            mentions
        });
        
    } catch (error) {
        console.error('خطأ في المنشن الجماعي:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء إجراء المنشن الجماعي.' });
    }
}

// وظيفة المنشن العشوائي (لـ 10 أشخاص)
async function randomMention(sock, groupId, sender, message = '') {
    try {
        const members = groupMembers[groupId];
        if (!members || members.length === 0) {
            await sock.sendMessage(groupId, { text: '❌ لا يمكن العثور على أعضاء المجموعة.' });
            return;
        }
        
        // اختيار 10 أعضاء عشوائياً (أو أقل إذا كان العدد أقل من 10)
        const filteredMembers = members.filter(member => member.id !== sender);
        const randomCount = Math.min(10, filteredMembers.length);
        const randomMembers = [];
        
        while (randomMembers.length < randomCount) {
            const randomIndex = Math.floor(Math.random() * filteredMembers.length);
            const randomMember = filteredMembers[randomIndex];
            if (!randomMembers.includes(randomMember)) {
                randomMembers.push(randomMember);
            }
        }
        
        const mentions = randomMembers.map(member => member.id);
        let mentionText = message || '🎲 منشن عشوائي';
        mentionText += '\n\n🎯 الأشخاص المختارون عشوائياً:\n';
        
        for (const member of randomMembers) {
            mentionText += `@${member.id.split('@')[0]} `;
        }
        
        mentionText += `\n\n📊 تم اختيار ${randomMembers.length} من أصل ${filteredMembers.length} عضو`;
        
        await sock.sendMessage(groupId, {
            text: mentionText,
            mentions
        });
        
    } catch (error) {
        console.error('خطأ في المنشن العشوائي:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء إجراء المنشن العشوائي.' });
    }
}

// التحقق من صلاحيات المستخدم
function isAuthorized(groupId, userId) {
    if (!authorizedUsers[groupId]) {
        authorizedUsers[groupId] = [];
    }
    
    // التحقق من كون المستخدم مشرف في المجموعة
    const members = groupMembers[groupId];
    if (members) {
        const member = members.find(m => m.id === userId);
        if (member && member.admin) {
            return true;
        }
    }
    
    // التحقق من القائمة المخصصة
    return authorizedUsers[groupId].includes(userId);
}

// ترقية مستخدم لاستخدام المنشن الجماعي
async function promoteUser(sock, groupId, sender, targetId) {
    try {
        // التحقق من صلاحيات المرقي
        if (!isAuthorized(groupId, sender)) {
            await sock.sendMessage(groupId, { text: '❌ ليس لديك صلاحية لترقية المستخدمين.' });
            return;
        }
        
        if (!targetId) {
            await sock.sendMessage(groupId, { text: '❌ يرجى تحديد المستخدم المراد ترقيته.' });
            return;
        }
        
        if (!authorizedUsers[groupId]) {
            authorizedUsers[groupId] = [];
        }
        
        if (authorizedUsers[groupId].includes(targetId)) {
            await sock.sendMessage(groupId, { 
                text: `⚠️ @${targetId.split('@')[0]} مرقى بالفعل لاستخدام المنشن الجماعي.`,
                mentions: [targetId]
            });
            return;
        }
        
        authorizedUsers[groupId].push(targetId);
        saveData();
        
        await sock.sendMessage(groupId, {
            text: `✅ تم ترقية @${targetId.split('@')[0]} بنجاح!\nيمكنه الآن استخدام أمر !منشن للمنشن الجماعي.`,
            mentions: [targetId]
        });
        
    } catch (error) {
        console.error('خطأ في ترقية المستخدم:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء محاولة ترقية المستخدم.' });
    }
}

// تنزيل رتبة مستخدم
async function demoteUser(sock, groupId, sender, targetId) {
    try {
        if (!isAuthorized(groupId, sender)) {
            await sock.sendMessage(groupId, { text: '❌ ليس لديك صلاحية لتنزيل رتبة المستخدمين.' });
            return;
        }
        
        if (!targetId) {
            await sock.sendMessage(groupId, { text: '❌ يرجى تحديد المستخدم المراد تنزيل رتبته.' });
            return;
        }
        
        if (!authorizedUsers[groupId] || !authorizedUsers[groupId].includes(targetId)) {
            await sock.sendMessage(groupId, { 
                text: `⚠️ @${targetId.split('@')[0]} ليس مرقى أصلاً.`,
                mentions: [targetId]
            });
            return;
        }
        
        authorizedUsers[groupId] = authorizedUsers[groupId].filter(id => id !== targetId);
        saveData();
        
        await sock.sendMessage(groupId, {
            text: `✅ تم تنزيل رتبة @${targetId.split('@')[0]} بنجاح!\nلم يعد بإمكانه استخدام المنشن الجماعي.`,
            mentions: [targetId]
        });
        
    } catch (error) {
        console.error('خطأ في تنزيل رتبة المستخدم:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء محاولة تنزيل رتبة المستخدم.' });
    }
}

// وظيفة طرد عضو
async function kickMember(sock, groupId, sender, targetId) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const isAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
        const botId = sock.user.id;
        const isBotAdmin = groupMetadata.participants.find(p => p.id === botId)?.admin;
        
        if (!isAdmin) {
            await sock.sendMessage(groupId, { text: '❌ يجب أن تكون مشرفًا لاستخدام هذا الأمر.' });
            return;
        }
        
        if (!isBotAdmin) {
            await sock.sendMessage(groupId, { text: '❌ يجب ترقية البوت إلى مشرف لاستخدام هذا الأمر.' });
            return;
        }
        
        if (!targetId) {
            await sock.sendMessage(groupId, { text: '❌ يرجى تحديد العضو المراد طرده.' });
            return;
        }
        
        await sock.groupParticipantsUpdate(groupId, [targetId], 'remove');
        await sock.sendMessage(groupId, { 
            text: `✅ تم طرد @${targetId.split('@')[0]} من المجموعة.`,
            mentions: [targetId]
        });
        
    } catch (error) {
        console.error('خطأ في طرد العضو:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء محاولة طرد العضو.' });
    }
}

// بدء لعبة إكس أو محسنة
async function startXOGame(sock, groupId, sender) {
    if (xoGames[groupId]) {
        await sock.sendMessage(groupId, { text: '⚠️ يوجد لعبة نشطة بالفعل في هذه المجموعة!' });
        return;
    }
    
    xoGames[groupId] = {
        board: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        currentPlayer: 'X',
        players: {
            'X': sender,
            'O': null
        },
        status: 'waiting'
    };
    
    updateUserStats(sender, 'game');
    
    await sock.sendMessage(groupId, { 
        text: `🎮 بدأت لعبة إكس أو جديدة!\n\n🎯 @${sender.split('@')[0]} يلعب كـ ❌\n\n⏳ لمن يريد الانضمام كـ ⭕ أرسل: !انضمام\n\n⏰ المهلة: 60 ثانية`,
        mentions: [sender]
    });
    
    await displayBoard(sock, groupId);
    
    setTimeout(async () => {
        const game = xoGames[groupId];
        if (game && game.players.O === null) {
            await sock.sendMessage(groupId, { text: '⏰ انتهت المهلة. تم إلغاء اللعبة.' });
            delete xoGames[groupId];
        }
    }, 60000);
}

// انضمام للعبة إكس أو
async function joinXOGame(sock, groupId, sender) {
    const game = xoGames[groupId];
    if (!game) {
        await sock.sendMessage(groupId, { text: '❌ لا توجد لعبة نشطة.' });
        return;
    }
    
    if (game.players.X === sender) {
        await sock.sendMessage(groupId, { text: '⚠️ أنت بالفعل في اللعبة!' });
        return;
    }
    
    if (game.players.O !== null) {
        await sock.sendMessage(groupId, { text: '⚠️ اللعبة مكتملة بالفعل!' });
        return;
    }
    
    game.players.O = sender;
    game.status = 'active';
    updateUserStats(sender, 'game');
    
    await sock.sendMessage(groupId, {
        text: `✅ @${sender.split('@')[0]} انضم للعبة كـ ⭕!\n\n🎮 اللعبة جاهزة للبدء!\n\n🎯 دور @${game.players[game.currentPlayer].split('@')[0]} (${game.currentPlayer === 'X' ? '❌' : '⭕'})`,
        mentions: [sender, game.players[game.currentPlayer]]
    });
    
    await displayBoard(sock, groupId);
}

// عرض لوحة اللعبة محسنة
async function displayBoard(sock, groupId) {
    const game = xoGames[groupId];
    if (!game) return;
    
    const board = game.board;
    let boardDisplay = `🎮 *لعبة إكس أو*\n\n`;
    
    if (game.status === 'active') {
        const currentPlayerName = game.players[game.currentPlayer].split('@')[0];
        const symbol = game.currentPlayer === 'X' ? '❌' : '⭕';
        boardDisplay += `🎯 دور: @${currentPlayerName} (${symbol})\n\n`;
    }
    
    // تحويل الأرقام إلى رموز أفضل
    const displayBoard = board.map(cell => {
        if (cell === 'X') return '❌';
        if (cell === 'O') return '⭕';
        return `${cell}️⃣`;
    });
    
    boardDisplay += `${displayBoard[0]} | ${displayBoard[1]} | ${displayBoard[2]}\n`;
    boardDisplay += `——————————\n`;
    boardDisplay += `${displayBoard[3]} | ${displayBoard[4]} | ${displayBoard[5]}\n`;
    boardDisplay += `——————————\n`;
    boardDisplay += `${displayBoard[6]} | ${displayBoard[7]} | ${displayBoard[8]}\n\n`;
    
    if (game.status === 'active') {
        boardDisplay += `🎲 للعب: !اختيار [رقم الخانة 1-9]`;
        const mentions = [game.players[game.currentPlayer]];
        await sock.sendMessage(groupId, { text: boardDisplay, mentions });
    } else {
        await sock.sendMessage(groupId, { text: boardDisplay });
    }
}

// التحقق من الفائز
function checkWinner(board) {
    const winCombinations = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];
    
    for (const combo of winCombinations) {
        const [a, b, c] = combo;
        if (board[a] === board[b] && board[b] === board[c]) {
            return board[a];
        }
    }
    
    // التحقق من التعادل
    if (!board.some(cell => typeof cell === 'number')) {
        return 'tie';
    }
    
    return null;
}

// اللعب في إكس أو
async function playXO(sock, groupId, player, position) {
    const game = xoGames[groupId];
    if (!game) {
        await sock.sendMessage(groupId, { text: '❌ لا توجد لعبة نشطة. استخدم !لعبة لبدء لعبة جديدة.' });
        return;
    }
    
    if (game.status !== 'active') {
        await sock.sendMessage(groupId, { text: '⚠️ اللعبة غير نشطة أو تنتظر لاعباً آخر.' });
        return;
    }
    
    if (game.players[game.currentPlayer] !== player) {
        await sock.sendMessage(groupId, { 
            text: `⚠️ ليس دورك! دور @${game.players[game.currentPlayer].split('@')[0]}`,
            mentions: [game.players[game.currentPlayer]]
        });
        return;
    }
    
    position -= 1; // تحويل من 1-9 إلى 0-8
    if (typeof game.board[position] === 'number') {
        game.board[position] = game.currentPlayer;
        
        const result = checkWinner(game.board);
        await displayBoard(sock, groupId);
        
        if (result) {
            if (result === 'tie') {
                await sock.sendMessage(groupId, { 
                    text: `🤝 انتهت اللعبة بالتعادل!\n\n👥 اللاعبان:\n❌ @${game.players.X.split('@')[0]}\n⭕ @${game.players.O.split('@')[0]}\n\n🎮 لعبة رائعة!`,
                    mentions: [game.players.X, game.players.O]
                });
            } else {
                const winner = game.players[result];
                const loser = game.players[result === 'X' ? 'O' : 'X'];
                const symbol = result === 'X' ? '❌' : '⭕';
                
                await sock.sendMessage(groupId, { 
                    text: `🎉 الفائز هو @${winner.split('@')[0]} (${symbol})!\n\n🏆 تهانينا على الفوز!\n👏 لعبة جيدة @${loser.split('@')[0]}`,
                    mentions: [winner, loser]
                });
                
                // تحديث إحصائيات الفائز
                updateUserStats(winner, 'game');
            }
            delete xoGames[groupId];
        } else {
            game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
            const nextPlayerName = game.players[game.currentPlayer].split('@')[0];
            const symbol = game.currentPlayer === 'X' ? '❌' : '⭕';
            
            await sock.sendMessage(groupId, { 
                text: `🎯 دور @${nextPlayerName} (${symbol}) للعب!`,
                mentions: [game.players[game.currentPlayer]]
            });
        }
    } else {
        await sock.sendMessage(groupId, { text: '❌ هذا الموقع مشغول بالفعل. اختر موقعًا آخر.' });
    }
}

// معلومات المجموعة
async function getGroupInfo(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const settings = groupSettings[groupId];
        
        let infoText = `📊 *معلومات المجموعة*\n\n`;
        infoText += `📌 الاسم: ${metadata.subject}\n`;
        infoText += `📝 الوصف: ${metadata.desc || 'لا يوجد وصف'}\n`;
        infoText += `📅 تاريخ الإنشاء: ${new Date(metadata.creation * 1000).toLocaleDateString('ar-SA')}\n`;
        infoText += `👥 عدد الأعضاء: ${metadata.participants.length}\n`;
        infoText += `👑 عدد المشرفين: ${metadata.participants.filter(p => p.admin).length}\n`;
        
        if (settings) {
            infoText += `\n🔧 *الإعدادات:*\n`;
            infoText += `🎉 الترحيب: ${settings.welcome_enabled ? 'مفعل' : 'معطل'}\n`;
            infoText += `🗑️ الحذف التلقائي: ${settings.auto_delete ? 'مفعل' : 'معطل'}\n`;
        }
        
        // إحصائيات إضافية
        const authorizedCount = authorizedUsers[groupId] ? authorizedUsers[groupId].length : 0;
        infoText += `\n📈 *الإحصائيات:*\n`;
        infoText += `🎖️ المخولون للمنشن: ${authorizedCount}\n`;
        infoText += `🎮 الألعاب النشطة: ${xoGames[groupId] ? '1' : '0'}\n`;
        
        await sock.sendMessage(groupId, { text: infoText });
        
    } catch (error) {
        console.error('خطأ في جلب معلومات المجموعة:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء جلب معلومات المجموعة.' });
    }
}

// معلومات المستخدم
async function getUserInfo(sock, chatId, userId) {
    try {
        const stats = userStats[userId];
        const userName = userId.split('@')[0];
        
        let infoText = `👤 *معلومات المستخدم*\n\n`;
        infoText += `📛 الاسم: ${userName}\n`;
        
        if (stats) {
            infoText += `📊 الرسائل: ${stats.messages}\n`;
            infoText += `⚡ الأوامر: ${stats.commands}\n`;
            infoText += `🎮 الألعاب: ${stats.games_played}\n`;
            infoText += `👥 المجموعات: ${stats.joined_groups}\n`;
            infoText += `⏰ آخر نشاط: ${new Date(stats.last_activity).toLocaleString('ar-SA')}\n`;
        } else {
            infoText += `📊 لم يتم العثور على إحصائيات`;
        }
        
        await sock.sendMessage(chatId, { text: infoText });
        
    } catch (error) {
        console.error('خطأ في جلب معلومات المستخدم:', error);
        await sock.sendMessage(chatId, { text: '❌ حدث خطأ أثناء جلب معلومات المستخدم.' });
    }
}

// إحصائيات المستخدم
async function getUserStats(sock, chatId, userId) {
    try {
        const stats = userStats[userId];
        const userName = userId.split('@')[0];
        
        if (!stats) {
            await sock.sendMessage(chatId, { text: '📊 لم يتم تسجيل أي إحصائيات بعد.' });
            return;
        }
        
        let statsText = `📈 *إحصائياتك يا ${userName}*\n\n`;
        statsText += `💬 الرسائل المرسلة: ${stats.messages}\n`;
        statsText += `⚡ الأوامر المستخدمة: ${stats.commands}\n`;
        statsText += `🎮 الألعاب الملعوبة: ${stats.games_played}\n`;
        statsText += `👥 المجموعات المنضمة: ${stats.joined_groups}\n`;
        statsText += `⏰ آخر نشاط: ${new Date(stats.last_activity).toLocaleString('ar-SA')}\n`;
        
        // حساب مستوى النشاط
        const totalActivity = stats.messages + stats.commands + stats.games_played;
        let activityLevel = 'مبتدئ 🌱';
        if (totalActivity > 100) activityLevel = 'نشط 🔥';
        if (totalActivity > 500) activityLevel = 'خبير ⭐';
        if (totalActivity > 1000) activityLevel = 'أسطورة 👑';
        
        statsText += `\n🏆 مستوى النشاط: ${activityLevel}`;
        
        await sock.sendMessage(chatId, { text: statsText });
        
    } catch (error) {
        console.error('خطأ في جلب إحصائيات المستخدم:', error);
        await sock.sendMessage(chatId, { text: '❌ حدث خطأ أثناء جلب الإحصائيات.' });
    }
}

// تعيين رسالة ترحيب مخصصة
async function setWelcomeMessage(sock, groupId, sender, message) {
    try {
        const members = groupMembers[groupId];
        if (members) {
            const member = members.find(m => m.id === sender);
            if (!member || !member.admin) {
                await sock.sendMessage(groupId, { text: '❌ يجب أن تكون مشرفًا لتغيير رسالة الترحيب.' });
                return;
            }
        }
        
        if (!message) {
            await sock.sendMessage(groupId, { text: '❌ يرجى كتابة رسالة الترحيب.' });
            return;
        }
        
        welcomeMessages[groupId] = message;
        saveData();
        
        await sock.sendMessage(groupId, { 
            text: `✅ تم تعيين رسالة ترحيب مخصصة:\n\n"${message}"` 
        });
        
    } catch (error) {
        console.error('خطأ في تعيين رسالة الترحيب:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء تعيين رسالة الترحيب.' });
    }
}

// حذف الرسائل (للمشرفين)
async function deleteMessages(sock, groupId, sender, count) {
    try {
        const members = groupMembers[groupId];
        if (members) {
            const member = members.find(m => m.id === sender);
            if (!member || !member.admin) {
                await sock.sendMessage(groupId, { text: '❌ يجب أن تكون مشرفًا لحذف الرسائل.' });
                return;
            }
        }
        
        // هذه ميزة محدودة في واتساب، لكن يمكن إضافة منطق للرسائل المحفوظة
        await sock.sendMessage(groupId, { 
            text: `🗑️ تم طلب حذف ${count} رسالة.\n⚠️ ملاحظة: لا يمكن حذف رسائل الآخرين تلقائياً في واتساب.` 
        });
        
    } catch (error) {
        console.error('خطأ في حذف الرسائل:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء محاولة حذف الرسائل.' });
    }
}

// قرعة المجموعة
async function groupLottery(sock, groupId, sender) {
    try {
        const members = groupMembers[groupId];
        if (!members || members.length === 0) {
            await sock.sendMessage(groupId, { text: '❌ لا يمكن العثور على أعضاء المجموعة.' });
            return;
        }
        
        const filteredMembers = members.filter(member => member.id !== sender);
        if (filteredMembers.length === 0) {
            await sock.sendMessage(groupId, { text: '❌ لا يوجد أعضاء كافيين للقرعة.' });
            return;
        }
        
        const randomIndex = Math.floor(Math.random() * filteredMembers.length);
        const winner = filteredMembers[randomIndex];
        
        let lotteryText = `🎰 *قرعة المجموعة* 🎰\n\n`;
        lotteryText += `🎉 الفائز المحظوظ هو:\n`;
        lotteryText += `🏆 @${winner.id.split('@')[0]}\n\n`;
        lotteryText += `🎊 تهانينا! أنت المختار من بين ${filteredMembers.length} عضو!\n`;
        lotteryText += `⏰ ${new Date().toLocaleString('ar-SA')}`;
        
        await sock.sendMessage(groupId, {
            text: lotteryText,
            mentions: [winner.id]
        });
        
    } catch (error) {
        console.error('خطأ في قرعة المجموعة:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء إجراء القرعة.' });
    }
}

// إنشاء تصويت
async function createPoll(sock, groupId, sender, question) {
    try {
        if (!question) {
            await sock.sendMessage(groupId, { text: '❌ يرجى كتابة سؤال التصويت.' });
            return;
        }
        
        let pollText = `📊 *تصويت جماعي* 📊\n\n`;
        pollText += `❓ السؤال: ${question}\n\n`;
        pollText += `👍 للموافقة اضغط على 👍\n`;
        pollText += `👎 للرفض اضغط على 👎\n`;
        pollText += `🤷 للحياد اضغط على 🤷\n\n`;
        pollText += `📝 أنشئ بواسطة: @${sender.split('@')[0]}\n`;
        pollText += `⏰ ${new Date().toLocaleString('ar-SA')}`;
        
        await sock.sendMessage(groupId, {
            text: pollText,
            mentions: [sender]
        });
        
    } catch (error) {
        console.error('خطأ في إنشاء التصويت:', error);
        await sock.sendMessage(groupId, { text: '❌ حدث خطأ أثناء إنشاء التصويت.' });
    }
}

// إرسال حكمة
async function sendWisdom(sock, chatId) {
    const wisdoms = [
        "🌟 النجاح ليس نهاية المطاف، والفشل ليس قاتلاً، إنما الشجاعة للمتابعة هي التي تهم.",
        "💪 لا تنتظر الفرصة المثالية، اصنعها بنفسك.",
        "🎯 الهدف بدون خطة مجرد أمنية.",
        "🌱 كل خبير كان مبتدئاً في يوم من الأيام.",
        "⭐ لا تقارن نفسك بالآخرين، قارن نفسك بمن كنت بالأمس.",
        "🚀 الطريق إلى النجاح دائماً قيد الإنشاء.",
        "🔥 اشتعل بالداخل حتى لا تنطفئ من الخارج.",
        "🎭 الحياة مسرح، فكن الممثل الرئيسي في قصتك.",
        "🌈 بعد كل عاصفة تأتي قوس قزح.",
        "💎 الضغط يصنع الألماس."
    ];
    
    const randomWisdom = wisdoms[Math.floor(Math.random() * wisdoms.length)];
    
    await sock.sendMessage(chatId, { 
        text: `💭 *حكمة اليوم*\n\n${randomWisdom}\n\n🕐 ${new Date().toLocaleString('ar-SA')}` 
    });
}

// رسالة المساعدة المحسنة
async function sendHelpMessage(sock, chatId, isGroup) {
    try {
        let helpText = `🤖 *دليل استخدام البوت* 🤖\n\n`;
        
        // الأوامر العامة
        helpText += `📋 *الأوامر العامة:*\n`;
        helpText += `!مرحبا - ترحيب من البوت\n`;
        helpText += `!معلومات - معلومات المجموعة/المستخدم\n`;
        helpText += `!احصائياتي - إحصائياتك الشخصية\n`;
        helpText += `!حكمة - حكمة عشوائية\n`;
        helpText += `!مساعدة - هذه القائمة\n\n`;
        
        if (isGroup) {
            // أوامر المجموعة
            helpText += `👥 *أوامر المجموعة:*\n`;
            helpText += `!منشن [رسالة] - منشن جماعي (للمخولين)\n`;
            helpText += `!منشن_عشوائي [رسالة] - منشن 10 أشخاص عشوائياً\n`;
            helpText += `!قرعة - اختيار عضو عشوائي\n`;
            helpText += `!تصويت [سؤال] - إنشاء تصويت\n\n`;
            
            // أوامر الإدارة
            helpText += `👑 *أوامر الإدارة:*\n`;
            helpText += `!ترقية [@شخص] - ترقية للمنشن الجماعي\n`;
            helpText += `!تنزيل [@شخص] - إزالة صلاحية المنشن\n`;
            helpText += `!طرد [@شخص] - طرد عضو\n`;
            helpText += `!ترحيب [رسالة] - تعيين رسالة ترحيب\n`;
            helpText += `!حذف [عدد] - حذف رسائل\n\n`;
            
            // أوامر الألعاب
            helpText += `🎮 *الألعاب:*\n`;
            helpText += `!لعبة - بدء لعبة إكس أو\n`;
            helpText += `!انضمام - الانضمام للعبة\n`;
            helpText += `!اختيار [1-9] - اللعب في إكس أو\n\n`;
        }
        
        // معلومات إضافية
        helpText += `ℹ️ *معلومات مفيدة:*\n`;
        helpText += `• يمكن للمشرفين استخدام جميع الأوامر\n`;
        helpText += `• المنشن الجماعي يتطلب ترخيص من المشرفين\n`;
        helpText += `• البوت يحفظ الإحصائيات تلقائياً\n`;
        helpText += `• جميع الألعاب تفاعلية ومتعددة اللاعبين\n\n`;
        
        helpText += `🔗 تطوير: بوت واتساب محسن\n`;
        helpText += `📅 التاريخ: ${new Date().toLocaleDateString('ar-SA')}`;
        
        await sock.sendMessage(chatId, { text: helpText });
        
    } catch (error) {
        console.error('خطأ في إرسال رسالة المساعدة:', error);
        await sock.sendMessage(chatId, { text: '❌ حدث خطأ أثناء عرض المساعدة.' });
    }
}

// بدء البوت مع معالجة الأخطاء
async function main() {
    try {
        console.log('🚀 بدء تشغيل بوت واتساب المحسن...');
        await startBot();
    } catch (error) {
        console.error('❌ خطأ في بدء تشغيل البوت:', error);
        // إعادة المحاولة بعد 5 ثوان
        setTimeout(main, 5000);
    }
}

// معالجة إنهاء البرنامج
process.on('SIGINT', () => {
    console.log('\n🛑 إيقاف البوت...');
    saveData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 إنهاء البوت...');
    saveData();
    process.exit(0);
});

// بدء البوت
main();