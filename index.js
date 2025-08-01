#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from 'fs/promises';
import path from 'path'; 
import { fileURLToPath } from 'url';
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from 'dotenv';
import FormData from 'form-data';
import axios from 'axios';
dotenv.config(); 
    

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = new Server(
  { 
    name: "mcp-images",
    version: "1.0.0",
  },
  {
    capabilities: { 
      tools: {},
    }, 
  }
);

// schemas
const generateImagesSchema = z.object({
  words: z.string(),
  provider: z.string().default("dalle3"), // dalle3 or stability, will integrate more later 
  style: z.string().default("realistic"),
  background: z.string().default("white"), 
  size: z.string().default("1024x1024"),
  quality: z.string().default("standard"), // standard or hd
  async: z.boolean().default(true) // avoid timeouts
}); 
 
const checkStatusSchema = z.object({
  jobId: z.string().describe("Job ID from generateImages")
});
 
const listImagesSchema = z.object({
  pattern: z.string().optional().describe("regex pattern to filter filenames")
});

const deleteImageSchema = z.object({
  filename: z.string().describe("name of the image file to delete")
});  
 
// configuration 
const config = {
  imageDir: path.join(__dirname, 'generated-images'),
  jobsDir: path.join(__dirname, 'jobs'),
  providers: {
    dalle3: {
      endpoint: 'https://api.openai.com/v1/images/generations',
      apiKey: process.env.OPENAI_API_KEY,
    }, 
    stability: {
      endpoint: 'https://api.stability.ai/v2beta/stable-image/generate/sd3',
      apiKey: process.env.STABILITY_API_KEY,
    }
  }
};


const activeJobs = new Map();

// Validate required keys, note that you have to set these in your .env file
if (!config.providers.dalle3.apiKey) {
  console.warn("OPENAI_API_KEY is not set in .env");
}
if (!config.providers.stability.apiKey) {
  console.warn("STABILITY_API_KEY is not set in .env");
}
 
//utility functions
async function ensureImageDirectory() {
  try {
    await fs.access(config.imageDir);
  } catch {
    await fs.mkdir(config.imageDir, { recursive: true });
  }
}

async function ensureJobsDirectory() {
  try {
    await fs.access(config.jobsDir);
  } catch {
    await fs.mkdir(config.jobsDir, { recursive: true });
  }
}
 
function buildPrompt(word, style, background) {
  const styles = {
    
    realistic: "photorealistic, high detail, professional photography, ",
    cartoon: "cartoon style, vibrant colors, exaggerated features, ",
    abstract: "abstract art, geometric shapes, expressive, ",
    minimal: "minimalist, clean lines, simple composition"
  }; 
  const stylePrompt = styles[style] || styles.ghibli;
  return `${background} background, ${stylePrompt}, ${word}`;
}

function sanitizeFilename(word) {
  return word.trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

// actual image generation
async function generateImages(input) {
  const { words, provider, style, background, size, quality, async } = generateImagesSchema.parse(input);
  
  if (async) {
    return await generateImagesAsync(input);
  } else {
    return await generateImagesSync(input);
  }
}

async function generateImagesAsync(input) {
  const { words, provider, style, background, size, quality } = generateImagesSchema.parse(input);
  const wordList = words.split(",")
    .map(words => words.trim())
    .filter(words => words.length > 0);

  if (wordList.length === 0) {
    throw new Error("No valid words provided.");
  }

  await ensureImageDirectory();
  await ensureJobsDirectory();

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const jobInfo = {
    id: jobId,
    status: 'started',
    totalWords: wordList.length,
    completedWords: 0,
    results: [],
    startTime: new Date().toISOString(),
    provider,
    style,
    background,
    size,
    quality
  };

  activeJobs.set(jobId, jobInfo);

  // Start generation in background
  generateImagesInBackground(jobId, wordList, provider, style, background, size, quality);

  return {
    jobId,
    status: 'started',
    message: `Started generating ${wordList.length} images using ${provider}. Use checkStatus with jobId to monitor progress.`,
    totalWords: wordList.length
  };
}
 
async function generateImagesInBackground(jobId, wordList, provider, style, background, size, quality) {
  const jobInfo = activeJobs.get(jobId);
  if (!jobInfo) return;  

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const [width, height] = size.split('x').map(Number);

  for (let i = 0; i < wordList.length; i++) {
    const word = wordList[i];
    const prompt = buildPrompt(word, style, background);
    const sanitizedWord = sanitizeFilename(word);
    const filename = `${sanitizedWord}_${timestamp}.png`;
    const filepath = path.join(config.imageDir, filename);

    console.error(`[INFO] Generating image ${i + 1}/${wordList.length} for: ${word} using ${provider}`);
    
    jobInfo.status = 'generating';
    jobInfo.currentWord = word;

    try { 
      let success = false;

      switch (provider.toLowerCase()) {
        case 'dalle3':
        case 'dall-e-3': {
          if (!config.providers.dalle3.apiKey) {
            throw new Error("Missing OPENAI_API_KEY");
          } 
 
          const response = await fetch(config.providers.dalle3.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.providers.dalle3.apiKey}`
            },  
            body: JSON.stringify({
              model: 'dall-e-3',
              prompt,
              size,
              quality,
              n: 1
            })
          }); 

          if (!response.ok) {
            const err = await response.json().catch(() => ({})); 
            throw new Error(err.error?.message || `HTTP ${response.status}`);
          }   

          const data = await response.json();
          const imageUrl = data.data[0].url;
 
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) throw new Error("Download failed");  
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          await fs.writeFile(filepath, buffer);

          jobInfo.results.push({ url: `file://${filepath}`, alt: `${style} image of ${word}`, width, height, filename, word });
          success = true;
          break; 
        }
 
        case 'stability': {
  if (!config.providers.stability.apiKey) {
    throw new Error("Missing STABILITY_API_KEY");
  }

  // Use their working format
  const payload = {
    prompt: prompt,
    output_format: "png", // or "webp" if you prefer
    width: width,
    height: height
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    // You'll need to install axios: npm install axios
    const response = await axios.postForm(
      `https://api.stability.ai/v2beta/stable-image/generate/ultra`,
      axios.toFormData(payload, new FormData()),
      {
        validateStatus: undefined,
        responseType: "arraybuffer",
        headers: { 
          Authorization: `Bearer ${config.providers.stability.apiKey}`, 
          Accept: "image/*" 
        },
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (response.status === 200) {
      const buffer = Buffer.from(response.data);
      await fs.writeFile(filepath, buffer);
      
      jobInfo.results.push({ 
        url: `file://${filepath}`, 
        alt: `${style} image of ${word}`, 
        width, 
        height, 
        filename, 
        word 
      });
      success = true;
    } else {
      throw new Error(`Stability API error ${response.status}: ${response.data.toString()}`);
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error("Stability API request timed out after 90 seconds");
    }
    throw error;
  }
  break;
}

        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }

      if (success) {
        console.error(`[SUCCESS] Generated: ${filename}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to generate image for "${word}":`, error.message);
      jobInfo.results.push({
        url: "",
        alt: `Failed to generate image for ${word}: ${error.message}`,
        width: 0,
        height: 0,   
        filename: "",
        word
      });  
    }
  
    jobInfo.completedWords = i + 1;
  }

  jobInfo.status = 'completed';
  jobInfo.endTime = new Date().toISOString();
  delete jobInfo.currentWord;

  console.error(`[JOB COMPLETE] ${jobId} - Generated ${jobInfo.results.filter(r => r.url).length}/${wordList.length} images`);
}

async function generateImagesSync(input) {
  // Keep the original synchronous version for when async = false, also because I don't want to undo my work even if it was the wrong thing haha
  const { words, provider, style, background, size, quality } = generateImagesSchema.parse(input);
  const wordList = words.split(",")
    .map(w => w.trim())
    .filter(w => w.length > 0);

  if (wordList.length === 0) {
    throw new Error("No valid words provided.");
  }

  await ensureImageDirectory();
  const results = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const [width, height] = size.split('x').map(Number);

  console.error(`[INFO] Starting synchronous generation of ${wordList.length} images using ${provider}...`);

  for (const word of wordList) {
    const prompt = buildPrompt(word, style, background);
    const sanitizedWord = sanitizeFilename(word);
    const filename = `${sanitizedWord}_${timestamp}.png`;
    const filepath = path.join(config.imageDir, filename);

    console.error(`[INFO] Generating image for: ${word} using ${provider}`);

    try {
      let success = false;

      switch (provider.toLowerCase()) {
        case 'dalle3':
        case 'dall-e-3': {
          if (!config.providers.dalle3.apiKey) {
            throw new Error("Missing OPENAI_API_KEY");
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);

          try {
            const response = await fetch(config.providers.dalle3.endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.providers.dalle3.apiKey}`
              },
              body: JSON.stringify({
                model: 'dall-e-3',
                prompt,
                size,
                quality,
                n: 1
              }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const err = await response.json().catch(() => ({}));
              throw new Error(err.error?.message || `HTTP ${response.status}`);
            }

            const data = await response.json();
            const imageUrl = data.data[0].url;

            const imgRes = await fetch(imageUrl);
            if (!imgRes.ok) throw new Error("Download failed");
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            await fs.writeFile(filepath, buffer);

            results.push({ url: `file://${filepath}`, alt: `${style} image of ${word}`, width, height, filename, word });
            success = true;
          } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
              throw new Error("DALL-E request timed out after 60 seconds");
            }
            throw error;
          }
          break;
        }

        case 'stability': {
          if (!config.providers.stability.apiKey) {
            throw new Error("Missing STABILITY_API_KEY");
          }

          const boundary = `----formdata-${Math.random().toString(36).substring(2)}`;
          const formFields = [
            ['prompt', prompt],
            ['width', width.toString()],
            ['height', height.toString()],
            ['samples', '1'],
            ['steps', '30'],
            ['cfg_scale', '7'],
            ['seed', Math.floor(Math.random() * 1000000).toString()]
          ];

          let formBody = '';
          for (const [key, value] of formFields) {
            formBody += `--${boundary}\r\n`;
            formBody += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
            formBody += `${value}\r\n`;
          } 
          formBody += `--${boundary}--\r\n`;

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 90000);
      
          try {
            const response = await fetch(config.providers.stability.endpoint, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${config.providers.stability.apiKey}`,
                'Accept': 'application/json',
                'Content-Type': `multipart/form-data; boundary=${boundary}`
              },
              body: formBody,
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`Stability API error ${response.status}: ${errText}`);
            } 

            const data = await response.json();
            
            let base64Image;
            if (data.artifacts && data.artifacts[0] && data.artifacts[0].base64) {
              base64Image = data.artifacts[0].base64;
            } else if (data.content && data.content[0]) {
              base64Image = data.content[0];
            } else {
              throw new Error("No image data returned from Stability API");
            }

            const buffer = Buffer.from(base64Image, 'base64');
            await fs.writeFile(filepath, buffer);

            results.push({ url: `file://${filepath}`, alt: `${style} image of ${word}`, width, height, filename, word });
            success = true;
          } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
              throw new Error("Stability API request timed out after 90 seconds");
            }
            throw error;
          }
          break;
        }

        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }

      if (success) {
        console.error(`[SUCCESS] Generated: ${filename}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to generate image for "${word}":`, error.message);
      results.push({
        url: "",
        alt: `Failed to generate image for ${word}: ${error.message}`,
        width: 0,
        height: 0,
        filename: "",
        word
      });
    }
  }

  return results;
}

//  check job status
async function checkStatus(input) {
  const { jobId } = checkStatusSchema.parse(input);
  
  const jobInfo = activeJobs.get(jobId);
  if (!jobInfo) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const response = {
    jobId: jobInfo.id,
    status: jobInfo.status,
    totalWords: jobInfo.totalWords,
    completedWords: jobInfo.completedWords,
    progress: `${jobInfo.completedWords}/${jobInfo.totalWords}`,
    startTime: jobInfo.startTime
  };

  if (jobInfo.currentWord) {
    response.currentWord = jobInfo.currentWord;
  }

  if (jobInfo.status === 'completed') {
    response.endTime = jobInfo.endTime;
    response.results = jobInfo.results;
    response.successCount = jobInfo.results.filter(r => r.url).length;
    response.failureCount = jobInfo.results.filter(r => !r.url).length;
  }

  return response;
}

// list images 
async function listImages(input) {
  const { pattern } = listImagesSchema.parse(input);
  await ensureImageDirectory();

  const files = await fs.readdir(config.imageDir);
  let imageFiles = files.filter(file =>
    /\.(png|jpe?g)$/i.test(file)
  );

  if (pattern) {
    const regex = new RegExp(pattern, 'i');
    imageFiles = imageFiles.filter(file => regex.test(file));
  }

  const results = await Promise.all(imageFiles.map(async (file) => {
    const filepath = path.join(config.imageDir, file);
    const stats = await fs.stat(filepath);
    return {
      filename: file,
      filepath: `file://${filepath}`,
      size: stats.size,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString()
    };
  }));

  return results.sort((a, b) => new Date(b.created) - new Date(a.created));
}

// delete image
async function deleteImage(input) {
  const { filename } = deleteImageSchema.parse(input);
  const filepath = path.join(config.imageDir, filename);

  try {
    await fs.access(filepath);
    await fs.unlink(filepath);
    return { success: true, message: `Deleted ${filename}` };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Image not found: ${filename}`);
    } 
    throw new Error(`Delete failed: ${error.message}`);
  }
}

// tool registration 
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generateImages",
      description: "Generates images for a list of words using DALL-E 3 or Stability AI. By default runs asynchronously to avoid timeouts.",
      inputSchema: zodToJsonSchema(generateImagesSchema)
    },
    {
      name: "checkStatus",
      description: "Check the status of an async image generation job using the jobId.",
      inputSchema: zodToJsonSchema(checkStatusSchema)
    },
    {
      name: "listImages",
      description: "Lists all generated images, optionally filtered by pattern.",
      inputSchema: zodToJsonSchema(listImagesSchema)
    },
    {
      name: "deleteImage",
      description: "Deletes a specific image file by filename.",
      inputSchema: zodToJsonSchema(deleteImageSchema)
    }
  ]
}));

// tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "generateImages":
        result = await generateImages(args);
        break;
      case "checkStatus":
        result = await checkStatus(args);
        break;
      case "listImages":
        result = await listImages(args);
        break;
      case "deleteImage":
        result = await deleteImage(args);
        break;
      default:  
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// start server 
async function main() { 
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(" MCP Image Generation Server is running");
  console.error("Image directory:", config.imageDir);
  console.error("Tools: generateImages (async by default), checkStatus, listImages, deleteImage");
}

main().catch(error => {
  console.error(" Server failed to start:", error);
  process.exit(1);
}); 