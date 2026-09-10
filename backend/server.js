require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 2026;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.static(path.join(__dirname, '../public')));

// File upload
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads', req.sessionId || 'temp');
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Database setup
const dbPath = path.join(__dirname, '../database/roadmaps.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB Error:', err);
    else console.log('✅ SQLite database connected');
});

// Initialize database
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS roadmaps (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            university TEXT NOT NULL,
            major TEXT NOT NULL,
            minor TEXT,
            careerPath TEXT NOT NULL,
            format TEXT,
            htmlPath TEXT,
            pdfPath TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS regenerations (
            id TEXT PRIMARY KEY,
            roadmapId TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(roadmapId) REFERENCES roadmaps(id)
        )
    `);
});

const dbRun = util.promisify(db.run.bind(db));
const dbGet = util.promisify(db.get.bind(db));
const dbAll = util.promisify(db.all.bind(db));

// Create necessary directories
(async () => {
    await fs.mkdir(path.join(__dirname, '../public/pdfs'), { recursive: true });
    await fs.mkdir(path.join(__dirname, '../public/html'), { recursive: true });
    await fs.mkdir(path.join(__dirname, '../uploads'), { recursive: true });
    await fs.mkdir(path.join(__dirname, '../database'), { recursive: true });
})();

// Claude AI Roadmap Generator
async function generateRoadmapWithClaude(userData) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('🔑 API Key check:', {
        loaded: !!apiKey,
        length: apiKey?.length,
        prefix: apiKey?.substring(0, 15) + '...'
    });

    const client = new Anthropic({ apiKey });

    const prompt = `You are an expert academic advisor and career strategist. Generate a personalized 4-year college roadmap for the following student:

STUDENT PROFILE:
- Name: ${userData.fullName}
- Email: ${userData.email}
- Desired University: ${userData.university}
- Desired Major: ${userData.major}
${userData.minor ? `- Desired Minor: ${userData.minor}` : ''}
- Target Career Path: ${userData.careerPath}

PERSONAL INFORMATION:
Academic Strengths: ${userData.academicStrengths}
Career Interests & Goals: ${userData.careerInterests}
${userData.motivations ? `Personal Motivations: ${userData.motivations}` : ''}
${userData.background ? `Unique Background: ${userData.background}` : ''}

Please generate a comprehensive, structured roadmap that includes:

1. EXECUTIVE SUMMARY (2-3 paragraphs)
   - Brief overview of the student's path
   - Key milestones and goals

2. FRESHMAN YEAR PLAN
   - Fall Semester: 4-5 recommended courses
   - Spring Semester: 4-5 recommended courses
   - Extracurriculars and activities to pursue
   - Key milestones

3. SOPHOMORE YEAR PLAN
   - Fall Semester: 4-5 recommended courses
   - Spring Semester: 4-5 recommended courses
   - Internship/research opportunities
   - Skills to develop

4. JUNIOR YEAR PLAN
   - Fall Semester: 4-5 recommended courses
   - Spring Semester: 4-5 recommended courses
   - Major internship/co-op placement
   - Professional development

5. SENIOR YEAR PLAN
   - Fall Semester: 4-5 recommended courses
   - Spring Semester: 4-5 recommended courses
   - Career preparation
   - Final projects/capstone

6. CAREER PATHWAY
   - 2-3 alternative career paths based on major
   - Target companies for each path
   - Entry-level positions
   - Salary expectations
   - Timeline to land roles

7. SKILLS & CERTIFICATIONS TO ACQUIRE
   - Technical skills (with timeline)
   - Soft skills
   - Recommended certifications
   - Languages/specializations

8. NETWORKING STRATEGY
   - Alumni connections at target companies
   - Professional organizations to join
   - Conferences and events
   - Informational interviews

9. KEY MILESTONES & CHECKPOINTS
   - Quarterly goals
   - Year-end evaluations
   - Adjustments to make if needed

10. RESOURCES & OPPORTUNITIES
    - Scholarships and funding
    - Study abroad opportunities
    - Mentorship programs
    - Career services to utilize

Format the response as clear, well-organized HTML that can be rendered directly in a browser. Use semantic HTML and inline CSS for styling with a clean, professional grayscale theme (black text on white background with subtle gray accents). Make it print-friendly and visually organized with clear sections, headings, and bullet points.`;

    try {
        console.log('📤 Sending request to Claude API (model: claude-opus-5)...');

        const message = await client.messages.create({
            model: "claude-opus-5",
            max_tokens: 8000,
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

        console.log('✅ Claude API Response received:', {
            type: typeof message,
            keys: Object.keys(message),
            stop_reason: message.stop_reason,
            content_type: Array.isArray(message.content) ? 'array' : typeof message.content,
            content_length: message.content?.length,
            first_content_type: message.content?.[0]?.type,
            first_content_text_type: typeof message.content?.[0]?.text,
            first_content_text_length: message.content?.[0]?.text?.length || 0
        });

        const textContent = message.content?.[0]?.text;

        if (typeof textContent !== 'string' || textContent.length === 0) {
            console.error('❌ ERROR: Invalid content from Claude');
            console.error('Content value:', textContent);
            console.error('Full message:', JSON.stringify(message, null, 2).substring(0, 1000));
            return '<h2>Error: Invalid AI Response</h2><p>Claude did not return valid text content. Please try again.</p>';
        }

        console.log(`✅ Generated ${textContent.length} characters of roadmap content`);
        return textContent;

    } catch (error) {
        console.error('❌ Claude API Error:', error.message);
        console.error('Error details:', error);
        throw new Error(`Failed to generate roadmap: ${error.message}`);
    }
}

// Generate HTML roadmap
function createRoadmapHTML(content, userData) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>College & Career Roadmap - ${userData.fullName}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #1a1a1a;
            background: white;
            line-height: 1.6;
            padding: 2rem;
            max-width: 1000px;
            margin: 0 auto;
        }

        header {
            border-bottom: 3px solid #000;
            padding-bottom: 2rem;
            margin-bottom: 2rem;
            text-align: center;
        }

        header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
            color: #000;
        }

        header p {
            font-size: 1.1rem;
            color: #333;
            margin-bottom: 0.25rem;
        }

        .student-info {
            background: #f5f5f5;
            border-left: 4px solid #000;
            padding: 1.5rem;
            margin-bottom: 2rem;
            border-radius: 4px;
        }

        .student-info p {
            margin-bottom: 0.5rem;
            font-size: 0.95rem;
        }

        h2 {
            font-size: 1.8rem;
            margin-top: 2rem;
            margin-bottom: 1rem;
            border-bottom: 2px solid #333;
            padding-bottom: 0.5rem;
            color: #000;
        }

        h3 {
            font-size: 1.3rem;
            margin-top: 1.5rem;
            margin-bottom: 0.75rem;
            color: #333;
        }

        ul, ol {
            margin-left: 2rem;
            margin-bottom: 1rem;
        }

        li {
            margin-bottom: 0.5rem;
            color: #1a1a1a;
        }

        p {
            margin-bottom: 1rem;
            color: #1a1a1a;
        }

        .section {
            margin-bottom: 2rem;
            page-break-inside: avoid;
        }

        .highlight {
            background: #f0f0f0;
            padding: 1rem;
            border-left: 4px solid #666;
            border-radius: 4px;
            margin: 1rem 0;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 1rem 0;
            background: white;
        }

        th {
            background: #333;
            color: white;
            padding: 0.75rem;
            text-align: left;
            font-weight: 600;
        }

        td {
            padding: 0.75rem;
            border-bottom: 1px solid #ddd;
        }

        tr:nth-child(even) {
            background: #f9f9f9;
        }

        .milestone {
            background: #fafafa;
            border: 1px solid #ddd;
            padding: 1rem;
            margin: 0.75rem 0;
            border-radius: 4px;
        }

        .milestone strong {
            color: #000;
        }

        footer {
            border-top: 2px solid #000;
            margin-top: 3rem;
            padding-top: 1rem;
            text-align: center;
            font-size: 0.9rem;
            color: #666;
        }

        @media print {
            body {
                padding: 0;
            }
            .no-print {
                display: none;
            }
        }
    </style>
</head>
<body>
    <header>
        <h1>🎓 College & Career Roadmap</h1>
        <p><strong>${userData.fullName}</strong></p>
        <p>Generated: ${new Date().toLocaleDateString()}</p>
    </header>

    <div class="student-info">
        <p><strong>University:</strong> ${userData.university}</p>
        <p><strong>Major:</strong> ${userData.major} ${userData.minor ? `+ ${userData.minor}` : ''}</p>
        <p><strong>Career Goal:</strong> ${userData.careerPath}</p>
    </div>

    <div class="section">
        ${content}
    </div>

    <footer>
        <p>This personalized roadmap was generated by College Roadmap Generator V2</p>
        <p>Powered by Claude AI | Created for ${userData.email}</p>
    </footer>
</body>
</html>`;
}

// Generate PDF from HTML (using Playwright)
async function generatePDF(htmlContent, filename) {
    let browser;
    try {
        browser = await chromium.launch();
        const page = await browser.newPage();
        const filepath = path.join(__dirname, '../public/pdfs', filename);

        await page.setContent(htmlContent, { waitUntil: 'networkidle' });
        await page.pdf({
            path: filepath,
            format: 'A4',
            margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
        });

        return `/pdfs/${filename}`;
    } catch (error) {
        console.error('PDF Generation Error:', error);
        throw new Error('Failed to generate PDF');
    } finally {
        if (browser) await browser.close();
    }
}

// Save HTML file
async function saveHTML(htmlContent, filename) {
    const filepath = path.join(__dirname, '../public/html', filename);
    await fs.writeFile(filepath, htmlContent, 'utf-8');
    return `/html/${filename}`;
}

// Main API endpoint
app.post('/api/generate', upload.any(), async (req, res) => {
    try {
        const { university, major, minor, careerPath, fullName, email, academicStrengths, careerInterests, motivations, background, format } = req.body;

        // Validate
        if (!university || !major || !careerPath || !fullName || !email || !academicStrengths || !careerInterests) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'Server API key not configured' });
        }

        const userData = { university, major, minor, careerPath, fullName, email, academicStrengths, careerInterests, motivations, background };
        const roadmapId = uuidv4();
        const timestamp = Date.now();

        // Generate roadmap content with Claude
        console.log(`📝 Generating roadmap for ${fullName}...`);
        const roadmapContent = await generateRoadmapWithClaude(userData);

        // Create full HTML
        const fullHTML = createRoadmapHTML(roadmapContent, userData);

        // Generate files based on format
        let htmlUrl, pdfUrl;

        if (format === 'html' || format === 'both') {
            const htmlFilename = `roadmap-${roadmapId}-${timestamp}.html`;
            htmlUrl = await saveHTML(fullHTML, htmlFilename);
            console.log(`✅ HTML saved: ${htmlUrl}`);
        }

        if (format === 'pdf' || format === 'both') {
            const pdfFilename = `roadmap-${roadmapId}-${timestamp}.pdf`;
            pdfUrl = await generatePDF(fullHTML, pdfFilename);
            console.log(`✅ PDF saved: ${pdfUrl}`);
        }

        // Save to database
        await dbRun(
            `INSERT INTO roadmaps (id, email, university, major, minor, careerPath, format, htmlPath, pdfPath)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [roadmapId, email, university, major, minor || null, careerPath, format, htmlUrl || null, pdfUrl || null]
        );

        res.json({
            roadmapId,
            university,
            major,
            careerPath,
            htmlUrl: htmlUrl || null,
            pdfUrl: pdfUrl || null,
            generatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Generation Error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate roadmap' });
    }
});

// Get roadmap history
app.get('/api/roadmaps/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const roadmaps = await dbAll('SELECT * FROM roadmaps WHERE email = ? ORDER BY createdAt DESC LIMIT 10', [email]);
        res.json(roadmaps);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch roadmaps' });
    }
});

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 College Roadmap Generator V2`);
    console.log(`================================`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📱 Open: http://localhost:${PORT}`);
    console.log(`🔗 Alternative: http://127.0.0.1:${PORT}`);
    console.log(`🗄️  Database: ${dbPath}`);
    console.log(`================================\n`);
});
