"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagePDFGenerator = void 0;
const pdfkit_1 = __importDefault(require("pdfkit"));
const fs = __importStar(require("fs"));
const messageManager_1 = require("./messageManager");
class MessagePDFGenerator {
    constructor() {
        this.pageWidth = 612; // Standard letter width in points
        this.pageHeight = 792; // Standard letter height in points
        this.margin = 30;
        this.phoneWidth = 350; // Max width for phone-like messages
        this.contentWidth = this.pageWidth - this.margin * 2;
        this.bubblePadding = 12;
        this.bubbleMarginBottom = 16; // Space between bubbles
        this.bubbleRadius = 16; // Rounded corners for text message feel
        this.fontSize = 11;
        this.lineHeight = 16;
    }
    log(...args) {
        try {
            console.log('[MessagePDFGenerator]', ...args);
        }
        catch {
            // Silently ignore EPIPE and other console errors during shutdown
        }
    }
    logError(...args) {
        try {
            console.error('[MessagePDFGenerator]', ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    async generateThreadPDF(thread, outputPath, attachmentPaths = new Map()) {
        this.log(`Generating PDF for thread ${thread.threadId}: ${outputPath}`);
        return new Promise((resolve, reject) => {
            try {
                const doc = new pdfkit_1.default({
                    size: 'Letter',
                    margin: this.margin,
                });
                const stream = fs.createWriteStream(outputPath);
                doc.pipe(stream);
                // Title
                doc
                    .fontSize(22)
                    .font('Helvetica-Bold')
                    .fillColor('#000000')
                    .text(`Conversation: ${thread.address}`, {
                    align: 'center',
                });
                if (thread.displayName) {
                    doc
                        .fontSize(13)
                        .font('Helvetica')
                        .fillColor('#666666')
                        .text(`(${thread.displayName})`, {
                        align: 'center',
                    });
                }
                // Metadata
                doc
                    .fontSize(10)
                    .font('Helvetica-Oblique')
                    .fillColor('#999999')
                    .text(`Messages: ${thread.messageCount} | Last: ${new Date(thread.lastMessageDate).toLocaleString()}`, { align: 'center' });
                doc.moveDown(1.5);
                // Messages
                for (const msg of thread.messages) {
                    this.addMessageBubble(doc, msg, thread.address, attachmentPaths);
                }
                doc.end();
                stream.on('finish', () => {
                    this.log(`PDF complete: ${outputPath}`);
                    resolve();
                });
                stream.on('error', reject);
            }
            catch (error) {
                reject(error);
            }
        });
    }
    addMessageBubble(doc, msg, contactNumber, attachmentPaths) {
        const isSent = msg.type === 2;
        const date = new Date(msg.date);
        const timeStr = date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        const dateStr = date.toLocaleDateString();
        let content = '';
        if (!('parts' in msg)) {
            content = msg.body;
        }
        else {
            const mmsParts = msg.parts;
            if (mmsParts.length > 0) {
                content = mmsParts
                    .map((part) => {
                    if (part.text)
                        return part.text;
                    const exportedPath = attachmentPaths.get((0, messageManager_1.messagePartKey)(msg.id, part.id));
                    if (exportedPath)
                        return `[Attachment saved: ${part.fileName || part.contentType} (${exportedPath})]`;
                    return part.fileName
                        ? `[Attachment not exported: ${part.fileName}]`
                        : `[${part.contentType}]`;
                })
                    .join('\n');
            }
            else {
                content = '[Media]';
            }
        }
        // Wrap text with proper character-level wrapping
        doc.fontSize(this.fontSize).font('Helvetica');
        const maxBubbleWidth = this.phoneWidth - this.bubblePadding * 2;
        const lines = this.wrapText(content, maxBubbleWidth, doc);
        // Calculate bubble dimensions
        const textHeight = lines.length * this.lineHeight;
        const bubbleHeight = textHeight + this.bubblePadding * 2;
        const bubbleWidth = Math.min(maxBubbleWidth + this.bubblePadding * 2, this.phoneWidth);
        // Position (left for received, right for sent)
        const bubbleX = isSent
            ? this.pageWidth - this.margin - bubbleWidth
            : this.margin;
        const currentY = doc.y;
        // Check if we need a new page
        if (currentY + bubbleHeight + 40 > this.pageHeight - this.margin) {
            doc.addPage();
        }
        // Draw bubble background with rounded corners
        const bubbleColor = isSent ? '#DCF8C6' : '#FFFFFF'; // WhatsApp-like green for sent, white for received
        doc.save();
        this.drawRoundedRect(doc, bubbleX, doc.y, bubbleWidth, bubbleHeight, this.bubbleRadius);
        doc.fillColor(bubbleColor).fill();
        // Draw border
        this.drawRoundedRect(doc, bubbleX, doc.y, bubbleWidth, bubbleHeight, this.bubbleRadius);
        doc.strokeColor('#E0E0E0').lineWidth(0.5).stroke();
        doc.restore();
        // Draw text inside bubble
        doc
            .fontSize(this.fontSize)
            .font('Helvetica')
            .fillColor('#000000');
        const textX = bubbleX + this.bubblePadding;
        const textY = doc.y + this.bubblePadding;
        // Draw each line of text
        lines.forEach((line, index) => {
            doc.text(line, textX, textY + index * this.lineHeight, {
                width: bubbleWidth - this.bubblePadding * 2,
                align: 'left',
                lineBreak: false,
            });
        });
        // Timestamp below bubble
        doc
            .fontSize(9)
            .font('Helvetica-Oblique')
            .fillColor('#999999')
            .text(timeStr, bubbleX, doc.y + bubbleHeight + 4, {
            width: bubbleWidth,
            align: isSent ? 'right' : 'left',
        });
        // Move down for next message
        doc.moveDown(Math.ceil(bubbleHeight / this.lineHeight) + 0.5);
    }
    wrapText(text, maxWidth, doc) {
        const lines = [];
        // Split by newlines first to preserve intentional line breaks
        const paragraphs = text.split('\n');
        for (const paragraph of paragraphs) {
            if (!paragraph) {
                lines.push('');
                continue;
            }
            const words = paragraph.split(' ');
            let currentLine = '';
            for (const word of words) {
                // Check if word itself is longer than maxWidth - need character-level wrapping
                if (doc.widthOfString(word) > maxWidth) {
                    // First, flush current line if it exists
                    if (currentLine) {
                        lines.push(currentLine);
                        currentLine = '';
                    }
                    // Break long word into characters
                    let remainingWord = word;
                    while (remainingWord) {
                        let fitted = '';
                        for (let i = 0; i < remainingWord.length; i++) {
                            const testStr = fitted + remainingWord[i];
                            if (doc.widthOfString(testStr) <= maxWidth) {
                                fitted = testStr;
                            }
                            else {
                                break;
                            }
                        }
                        if (fitted) {
                            lines.push(fitted);
                            remainingWord = remainingWord.slice(fitted.length);
                        }
                        else {
                            // Fallback: at least one character
                            lines.push(remainingWord[0]);
                            remainingWord = remainingWord.slice(1);
                        }
                    }
                    continue;
                }
                const testLine = currentLine ? `${currentLine} ${word}` : word;
                const width = doc.widthOfString(testLine);
                if (width > maxWidth) {
                    if (currentLine) {
                        lines.push(currentLine);
                    }
                    currentLine = word;
                }
                else {
                    currentLine = testLine;
                }
            }
            if (currentLine) {
                lines.push(currentLine);
            }
        }
        return lines;
    }
    drawRoundedRect(doc, x, y, width, height, radius) {
        // Draw a rounded rectangle by moving around the perimeter with curves at corners
        const r = Math.min(radius, width / 2, height / 2);
        doc
            .moveTo(x + r, y)
            .lineTo(x + width - r, y)
            .quadraticCurveTo(x + width, y, x + width, y + r)
            .lineTo(x + width, y + height - r)
            .quadraticCurveTo(x + width, y + height, x + width - r, y + height)
            .lineTo(x + r, y + height)
            .quadraticCurveTo(x, y + height, x, y + height - r)
            .lineTo(x, y + r)
            .quadraticCurveTo(x, y, x + r, y);
    }
    async generateCombinedPDF(threads, outputPath, attachmentPaths = new Map()) {
        this.log(`Generating combined PDF for ${threads.length} threads: ${outputPath}`);
        return new Promise((resolve, reject) => {
            try {
                const doc = new pdfkit_1.default({
                    size: 'Letter',
                    margin: this.margin,
                });
                const stream = fs.createWriteStream(outputPath);
                doc.pipe(stream);
                // Cover page
                doc
                    .fontSize(28)
                    .font('Helvetica-Bold')
                    .text('Message Backup', { align: 'center' });
                doc.moveDown(1);
                doc
                    .fontSize(12)
                    .font('Helvetica')
                    .text(`Generated: ${new Date().toLocaleString()}`, {
                    align: 'center',
                });
                doc
                    .fontSize(10)
                    .text(`Total Conversations: ${threads.length}`, { align: 'center' })
                    .text(`Total Messages: ${threads.reduce((sum, t) => sum + t.messageCount, 0)}`, { align: 'center' });
                doc.addPage();
                // Table of contents
                doc.fontSize(14).font('Helvetica-Bold').text('Contents', {});
                doc.moveDown(0.5);
                threads.forEach((thread, index) => {
                    doc
                        .fontSize(10)
                        .font('Helvetica')
                        .text(`${index + 1}. ${thread.address}${thread.displayName ? ` (${thread.displayName})` : ''} - ${thread.messageCount} messages`);
                });
                doc.addPage();
                // Conversations
                threads.forEach((thread, index) => {
                    doc
                        .fontSize(16)
                        .font('Helvetica-Bold')
                        .text(`${index + 1}. ${thread.address}`);
                    if (thread.displayName) {
                        doc
                            .fontSize(12)
                            .font('Helvetica')
                            .text(`(${thread.displayName})`);
                    }
                    doc
                        .fontSize(9)
                        .font('Helvetica-Oblique')
                        .fillColor('#666666')
                        .text(`${thread.messageCount} messages`);
                    doc.moveDown(0.5);
                    // Messages for this thread
                    for (const msg of thread.messages) {
                        this.addMessageBubble(doc, msg, thread.address, attachmentPaths);
                    }
                    if (index < threads.length - 1) {
                        doc.addPage();
                    }
                });
                doc.end();
                stream.on('finish', () => {
                    this.log(`Combined PDF complete: ${outputPath}`);
                    resolve();
                });
                stream.on('error', reject);
            }
            catch (error) {
                reject(error);
            }
        });
    }
}
exports.MessagePDFGenerator = MessagePDFGenerator;
