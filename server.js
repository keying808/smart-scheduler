// server.js - 智能日程管理器后端服务
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态文件服务
app.use(express.static('public'));

// 文件上传配置
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB限制
});

// 数据存储路径
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');

// 确保数据目录存在
async function ensureDataDir() {
    const dataDir = path.dirname(DATA_FILE);
    try {
        await fs.access(dataDir);
    } catch {
        await fs.mkdir(dataDir, { recursive: true });
    }
}

// 读取任务数据
async function readTasks() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// 保存任务数据
async function saveTasks(tasks) {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2));
        return true;
    } catch (error) {
        console.error('保存任务失败:', error);
        return false;
    }
}

// 增强的智能文本解析函数
function parseTaskText(text) {
    const task = {
        title: '',
        description: text,
        dueDate: null,
        startTime: null,
        endTime: null,
        category: 'other',
        links: [],
        details: '',
        completed: false,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    // 提取链接
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const links = text.match(urlRegex) || [];
    task.links = links;

    // 移除链接后的文本
    const textWithoutLinks = text.replace(urlRegex, '').trim();

    // 时间解析 - 支持多种格式
    const now = new Date();
    let foundDate = null;
    let foundStartTime = null;
    let foundEndTime = null;

    // 1. 相对时间模式
    const relativeTimePatterns = [
        { pattern: /今天|today/i, days: 0 },
        { pattern: /明天|tomorrow/i, days: 1 },
        { pattern: /后天/i, days: 2 },
        { pattern: /大后天/i, days: 3 },
        { pattern: /下周一|next monday/i, days: getDaysUntilWeekday(1) },
        { pattern: /下周二|next tuesday/i, days: getDaysUntilWeekday(2) },
        { pattern: /下周三|next wednesday/i, days: getDaysUntilWeekday(3) },
        { pattern: /下周四|next thursday/i, days: getDaysUntilWeekday(4) },
        { pattern: /下周五|next friday/i, days: getDaysUntilWeekday(5) },
        { pattern: /下周六|next saturday/i, days: getDaysUntilWeekday(6) },
        { pattern: /下周日|下周天|next sunday/i, days: getDaysUntilWeekday(0) },
        { pattern: /(\d+)天后/, days: (match) => parseInt(match[1]) },
        { pattern: /一周后|next week/i, days: 7 },
        { pattern: /两周后/i, days: 14 },
        { pattern: /一个月后/i, days: 30 }
    ];

    // 2. 绝对时间模式 - 支持更多格式
    const absoluteTimePatterns = [
        // 支持 8.14, 8/14, 8-14 等格式
        { pattern: /(\d{1,2})[\.\/\-](\d{1,2})(?:[\.\/\-](\d{2,4}))?/, type: 'mdy' },
        // 支持传统格式：3月15日
        { pattern: /(\d{1,2})月(\d{1,2})[日号]?/, type: 'chinese' },
        // 支持完整日期格式
        { pattern: /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})[日号]?/, type: 'full' }
    ];

    // 3. 时间模式 - 识别具体小时
    const timePatterns = [
        // 上午9点, 下午2点
        { pattern: /上午(\d{1,2})[点时]?/, modifier: 'am' },
        { pattern: /下午(\d{1,2})[点时]?/, modifier: 'pm' },
        { pattern: /晚上(\d{1,2})[点时]?/, modifier: 'pm' },
        { pattern: /中午(\d{1,2})[点时]?/, modifier: 'noon' },
        // 9:30, 14:30
        { pattern: /(\d{1,2}):(\d{1,2})/, modifier: 'time' },
        // 9点, 14点
        { pattern: /(\d{1,2})[点时]/, modifier: 'hour' },
        // 时间范围：9-11点, 2点到4点
        { pattern: /(\d{1,2})[点时]?[-到至](\d{1,2})[点时]/, modifier: 'range' },
        { pattern: /(\d{1,2}):(\d{1,2})[-到至](\d{1,2}):(\d{1,2})/, modifier: 'timeRange' },
        // 上午9点到11点
        { pattern: /上午(\d{1,2})[点时]?[-到至](\d{1,2})[点时]?/, modifier: 'amRange' },
        { pattern: /下午(\d{1,2})[点时]?[-到至](\d{1,2})[点时]?/, modifier: 'pmRange' }
    ];

    // 尝试解析相对时间
    for (let pattern of relativeTimePatterns) {
        const match = textWithoutLinks.match(pattern.pattern);
        if (match) {
            const days = typeof pattern.days === 'function' 
                ? pattern.days(match) 
                : pattern.days;
            foundDate = new Date(now);
            foundDate.setDate(now.getDate() + days);
            break;
        }
    }

    // 尝试解析绝对时间
    if (!foundDate) {
        for (let pattern of absoluteTimePatterns) {
            const match = textWithoutLinks.match(pattern.pattern);
            if (match) {
                let year = now.getFullYear();
                let month, day;

                switch (pattern.type) {
                    case 'mdy':
                        month = parseInt(match[1]);
                        day = parseInt(match[2]);
                        if (match[3]) {
                            year = parseInt(match[3]);
                            if (year < 100) year += 2000; // 处理两位年份
                        }
                        break;
                    case 'chinese':
                        month = parseInt(match[1]);
                        day = parseInt(match[2]);
                        break;
                    case 'full':
                        year = parseInt(match[1]);
                        month = parseInt(match[2]);
                        day = parseInt(match[3]);
                        break;
                }
                
                if (month && day && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                    const testDate = new Date(year, month - 1, day);
                    // 如果是今年的日期或未来日期，则采用
                    if (testDate >= new Date(now.getFullYear(), 0, 1) || 
                        testDate.getFullYear() > now.getFullYear()) {
                        foundDate = testDate;
                        break;
                    }
                }
            }
        }
    }

    // 解析时间
    for (let pattern of timePatterns) {
        const match = textWithoutLinks.match(pattern.pattern);
        if (match) {
            switch (pattern.modifier) {
                case 'am':
                    let amHour = parseInt(match[1]);
                    if (amHour === 12) amHour = 0; // 12 AM = 0:00
                    foundStartTime = `${String(amHour).padStart(2, '0')}:00`;
                    break;
                case 'pm':
                    let pmHour = parseInt(match[1]);
                    if (pmHour !== 12) pmHour += 12; // 除了12 PM，其他都要+12
                    foundStartTime = `${String(pmHour).padStart(2, '0')}:00`;
                    break;
                case 'noon':
                    foundStartTime = '12:00';
                    break;
                case 'time':
                    foundStartTime = `${String(parseInt(match[1])).padStart(2, '0')}:${String(parseInt(match[2])).padStart(2, '0')}`;
                    break;
                case 'hour':
                    let h = parseInt(match[1]);
                    foundStartTime = `${String(h).padStart(2, '0')}:00`;
                    break;
                case 'range':
                    let startH = parseInt(match[1]);
                    let endH = parseInt(match[2]);
                    foundStartTime = `${String(startH).padStart(2, '0')}:00`;
                    foundEndTime = `${String(endH).padStart(2, '0')}:00`;
                    break;
                case 'timeRange':
                    foundStartTime = `${String(parseInt(match[1])).padStart(2, '0')}:${String(parseInt(match[2])).padStart(2, '0')}`;
                    foundEndTime = `${String(parseInt(match[3])).padStart(2, '0')}:${String(parseInt(match[4])).padStart(2, '0')}`;
                    break;
                case 'amRange':
                    let amStart = parseInt(match[1]);
                    let amEnd = parseInt(match[2]);
                    if (amStart === 12) amStart = 0;
                    if (amEnd === 12) amEnd = 0;
                    foundStartTime = `${String(amStart).padStart(2, '0')}:00`;
                    foundEndTime = `${String(amEnd).padStart(2, '0')}:00`;
                    break;
                case 'pmRange':
                    let pmStart = parseInt(match[1]);
                    let pmEnd = parseInt(match[2]);
                    if (pmStart !== 12) pmStart += 12;
                    if (pmEnd !== 12) pmEnd += 12;
                    foundStartTime = `${String(pmStart).padStart(2, '0')}:00`;
                    foundEndTime = `${String(pmEnd).padStart(2, '0')}:00`;
                    break;
            }
            break;
        }
    }

    // 设置解析结果
    if (foundDate) {
        task.dueDate = foundDate;
    }
    if (foundStartTime) {
        task.startTime = foundStartTime;
    }
    if (foundEndTime) {
        task.endTime = foundEndTime;
    }

    // 分类判断（更精确的关键词匹配）
    const categoryKeywords = {
        study: /作业|homework|考试|exam|上课|class|课程|course|学习|study|assignment|论文|paper|实验|lab|预习|复习|quiz|测验|讲座|lecture|教材|书本|笔记|note|背书|记忆|练习|习题|毕业设计|导师|教授|同学|讨论|研究/i,
        work: /工作|work|会议|meeting|项目|project|任务|task|简历|resume|投递|apply|面试|interview|报告|report|客户|client|加班|overtime|同事|colleague|老板|boss|公司|company|办公|office|职场|career|薪资|salary/i,
        personal: /约会|date|聚会|party|购物|shopping|电话|call|银行|bank|办理|handle|医院|hospital|体检|checkup|生日|birthday|健身|gym|运动|exercise|旅行|travel|休息|rest|娱乐|entertainment|朋友|friend|家人|family|吃饭|dinner|看电影|movie/i
    };

    for (let [category, regex] of Object.entries(categoryKeywords)) {
        if (regex.test(textWithoutLinks)) {
            task.category = category;
            break;
        }
    }

    // 提取干净的标题 - 更智能的处理
    let title = textWithoutLinks;
    
    // 移除时间相关表达（更全面）
    title = title.replace(/\d+天后|今天|明天|后天|大后天|下周[一二三四五六日天]|一周后|两周后|一个月后|上午|下午|晚上|中午|\d{1,2}[\.\/\-]\d{1,2}(?:[\.\/\-]\d{2,4})?|\d{1,2}月\d{1,2}[日号]?|\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}[日号]?|\d{1,2}[点时](\d{1,2}分?)?|\d{1,2}:\d{1,2}|\d{1,2}[点时]?[-到至]\d{1,2}[点时]?/g, '');
    
    // 移除常见动词和连接词
    title = title.replace(/前|要|需要|记得|别忘了|完成|提交|参加|去|到|在|和|与|跟|给|为了|关于|的|了|是|有|会|将|把|被|让|使|做|进行|开始|结束|准备|安排/g, '');
    
    // 移除多余的标点符号
    title = title.replace(/[，。！？；：""''（）【】]/g, ' ');
    
    // 清理多余空白并截取合理长度
    title = title.trim().replace(/\s+/g, ' ');
    
    // 如果标题太长，智能截取
    if (title.length > 25) {
        // 尝试找到合适的断点（空格、标点等）
        const words = title.split(' ');
        let result = '';
        for (let word of words) {
            if ((result + word).length <= 25) {
                result += (result ? ' ' : '') + word;
            } else {
                break;
            }
        }
        title = result || title.substring(0, 25);
    }
    
    // 如果标题为空或太短，尝试从原文本中提取关键词
    if (!title || title.length < 2) {
        const keywords = textWithoutLinks.match(/[a-zA-Z\u4e00-\u9fa5]{2,}/g);
        if (keywords && keywords.length > 0) {
            title = keywords.slice(0, 3).join(' ');
            if (title.length > 25) {
                title = title.substring(0, 25);
            }
        }
    }
    
    task.title = title || '新任务';
    task.details = textWithoutLinks;

    return task;
}

// 获取到指定星期几的天数
function getDaysUntilWeekday(targetDay) {
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntil = (targetDay - currentDay + 7) % 7;
    return daysUntil === 0 ? 7 : daysUntil;
}

// API路由

// 获取所有任务
app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await readTasks();
        res.json(tasks);
    } catch (error) {
        console.error('获取任务失败:', error);
        res.status(500).json({ error: '获取任务失败' });
    }
});

// 创建新任务
app.post('/api/tasks', async (req, res) => {
    try {
        const { text, imageText } = req.body;
        const inputText = text || imageText;
        
        if (!inputText || !inputText.trim()) {
            return res.status(400).json({ error: '任务内容不能为空' });
        }

        const parsedTask = parseTaskText(inputText);
        const newTask = {
            ...parsedTask,
            id: Date.now().toString(),
            createdAt: new Date(),
            updatedAt: new Date(),
            todayReminded: false,
            threeDayReminded: false
        };

        const tasks = await readTasks();
        tasks.push(newTask);
        
        const saved = await saveTasks(tasks);
        if (saved) {
            res.status(201).json(newTask);
        } else {
            res.status(500).json({ error: '保存任务失败' });
        }
    } catch (error) {
        console.error('创建任务失败:', error);
        res.status(500).json({ error: '创建任务失败' });
    }
});

// 更新任务
app.put('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // 移除不应该更新的字段
        delete updates.id;
        delete updates.createdAt;
        
        const tasks = await readTasks();
        const taskIndex = tasks.findIndex(task => task.id === id);
        
        if (taskIndex === -1) {
            return res.status(404).json({ error: '任务不存在' });
        }
        
        tasks[taskIndex] = {
            ...tasks[taskIndex],
            ...updates,
            updatedAt: new Date()
        };
        
        const saved = await saveTasks(tasks);
        if (saved) {
            res.json(tasks[taskIndex]);
        } else {
            res.status(500).json({ error: '更新任务失败' });
        }
    } catch (error) {
        console.error('更新任务失败:', error);
        res.status(500).json({ error: '更新任务失败' });
    }
});

// 删除任务
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const tasks = await readTasks();
        const filteredTasks = tasks.filter(task => task.id !== id);
        
        if (filteredTasks.length === tasks.length) {
            return res.status(404).json({ error: '任务不存在' });
        }
        
        const saved = await saveTasks(filteredTasks);
        if (saved) {
            res.json({ message: '任务删除成功' });
        } else {
            res.status(500).json({ error: '删除任务失败' });
        }
    } catch (error) {
        console.error('删除任务失败:', error);
        res.status(500).json({ error: '删除任务失败' });
    }
});

// 批量操作
app.post('/api/tasks/batch', async (req, res) => {
    try {
        const { action, taskIds, data } = req.body;
        const tasks = await readTasks();
        
        switch (action) {
            case 'delete':
                const filteredTasks = tasks.filter(task => !taskIds.includes(task.id));
                await saveTasks(filteredTasks);
                res.json({ message: `删除了${taskIds.length}个任务` });
                break;
                
            case 'complete':
                tasks.forEach(task => {
                    if (taskIds.includes(task.id)) {
                        task.completed = true;
                        task.updatedAt = new Date();
                    }
                });
                await saveTasks(tasks);
                res.json({ message: `完成了${taskIds.length}个任务` });
                break;
                
            case 'update':
                tasks.forEach(task => {
                    if (taskIds.includes(task.id)) {
                        Object.assign(task, data, { updatedAt: new Date() });
                    }
                });
                await saveTasks(tasks);
                res.json({ message: `更新了${taskIds.length}个任务` });
                break;
                
            default:
                res.status(400).json({ error: '不支持的批量操作' });
        }
    } catch (error) {
        console.error('批量操作失败:', error);
        res.status(500).json({ error: '批量操作失败' });
    }
});

// 获取统计信息
app.get('/api/stats', async (req, res) => {
    try {
        const tasks = await readTasks();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        
        const stats = {
            total: tasks.length,
            completed: tasks.filter(task => task.completed).length,
            pending: tasks.filter(task => !task.completed).length,
            overdue: tasks.filter(task => 
                !task.completed && 
                task.dueDate && 
                new Date(task.dueDate) < today
            ).length,
            dueToday: tasks.filter(task => 
                !task.completed && 
                task.dueDate && 
                new Date(task.dueDate).toDateString() === today.toDateString()
            ).length,
            dueTomorrow: tasks.filter(task => 
                !task.completed && 
                task.dueDate && 
                new Date(task.dueDate).toDateString() === tomorrow.toDateString()
            ).length,
            dueThisWeek: tasks.filter(task => 
                !task.completed && 
                task.dueDate && 
                new Date(task.dueDate) <= nextWeek &&
                new Date(task.dueDate) > today
            ).length,
            byCategory: {
                study: tasks.filter(task => task.category === 'study').length,
                work: tasks.filter(task => task.category === 'work').length,
                personal: tasks.filter(task => task.category === 'personal').length,
                other: tasks.filter(task => task.category === 'other').length
            }
        };
        
        res.json(stats);
    } catch (error) {
        console.error('获取统计信息失败:', error);
        res.status(500).json({ error: '获取统计信息失败' });
    }
});

// 导出数据
app.get('/api/export', async (req, res) => {
    try {
        const tasks = await readTasks();
        const exportData = {
            exportDate: new Date(),
            tasks: tasks,
            version: '2.0'
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=tasks-export.json');
        res.json(exportData);
    } catch (error) {
        console.error('导出数据失败:', error);
        res.status(500).json({ error: '导出数据失败' });
    }
});

// 导入数据
app.post('/api/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }
        
        const fileContent = req.file.buffer.toString('utf8');
        const importData = JSON.parse(fileContent);
        
        if (!importData.tasks || !Array.isArray(importData.tasks)) {
            return res.status(400).json({ error: '文件格式不正确' });
        }
        
        const existingTasks = await readTasks();
        const newTasks = importData.tasks.filter(importTask => 
            !existingTasks.find(existing => existing.id === importTask.id)
        );
        
        const allTasks = [...existingTasks, ...newTasks];
        await saveTasks(allTasks);
        
        res.json({ 
            message: `成功导入${newTasks.length}个新任务`,
            imported: newTasks.length,
            total: allTasks.length
        });
    } catch (error) {
        console.error('导入数据失败:', error);
        res.status(500).json({ error: '导入数据失败' });
    }
});

// 智能解析测试接口
app.post('/api/parse-test', (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: '请提供测试文本' });
        }
        
        const result = parseTaskText(text);
        res.json({
            original: text,
            parsed: result,
            timestamp: new Date()
        });
    } catch (error) {
        console.error('解析测试失败:', error);
        res.status(500).json({ error: '解析测试失败' });
    }
});

// 提醒检查 - 定时任务
cron.schedule('*/10 * * * *', async () => {
    try {
        const tasks = await readTasks();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const threeDaysFromNow = new Date(today);
        threeDaysFromNow.setDate(today.getDate() + 3);

        let remindersToSend = [];
        let tasksUpdated = false;

        tasks.forEach(task => {
            if (!task.dueDate || task.completed) return;

            const taskDate = new Date(task.dueDate);
            const taskDateOnly = new Date(taskDate.getFullYear(), taskDate.getMonth(), taskDate.getDate());
            
            // 当天提醒
            if (taskDateOnly.getTime() === today.getTime() && !task.todayReminded) {
                remindersToSend.push({
                    type: 'today',
                    task: task,
                    message: `今天截止: ${task.title}`,
                    time: task.startTime ? `时间: ${task.startTime}` : ''
                });
                task.todayReminded = true;
                tasksUpdated = true;
            }
            
            // 三天前提醒
            if (taskDateOnly.getTime() === threeDaysFromNow.getTime() && !task.threeDayReminded) {
                remindersToSend.push({
                    type: 'threeDays',
                    task: task,
                    message: `3天后截止: ${task.title}`,
                    time: task.startTime ? `时间: ${task.startTime}` : ''
                });
                task.threeDayReminded = true;
                tasksUpdated = true;
            }
        });

        if (tasksUpdated) {
            await saveTasks(tasks);
        }

        if (remindersToSend.length > 0) {
            console.log(`\n📋 发送${remindersToSend.length}个提醒 [${new Date().toLocaleString()}]`);
            remindersToSend.forEach(reminder => {
                console.log(`🔔 ${reminder.message}`);
                if (reminder.time) console.log(`   ${reminder.time}`);
                console.log(`   分类: ${getCategoryName(reminder.task.category)}`);
                console.log(`   详情: ${reminder.task.details.substring(0, 50)}...`);
                console.log('');
            });
        }
    } catch (error) {
        console.error('提醒检查失败:', error);
    }
});

// 辅助函数：获取分类中文名
function getCategoryName(category) {
    const names = {
        study: '📚 学习',
        work: '💼 工作',
        personal: '🏠 生活',
        other: '📁 其他'
    };
    return names[category] || names.other;
}

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date(),
        uptime: process.uptime(),
        version: '2.0'
    });
});

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('服务器错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
});

// 404 处理
app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

// 启动服务器
async function startServer() {
    await ensureDataDir();
    
    app.listen(PORT, () => {
        console.log(`\n🚀 智能日程管理器 v2.0 已启动`);
        console.log(`📍 服务地址: http://localhost:${PORT}`);
        console.log(`💾 数据文件: ${DATA_FILE}`);
        console.log(`⏰ 提醒检查: 每10分钟一次`);
        console.log(`✨ 新功能: 增强自然语言理解、时间解析、任务分类管理\n`);
    });
}

startServer().catch(console.error);