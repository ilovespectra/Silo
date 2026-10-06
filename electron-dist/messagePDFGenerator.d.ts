import { MessageAttachmentPaths, MessageThread } from './messageManager';
export declare class MessagePDFGenerator {
    private pageWidth;
    private pageHeight;
    private margin;
    private phoneWidth;
    private contentWidth;
    private bubblePadding;
    private bubbleMarginBottom;
    private bubbleRadius;
    private fontSize;
    private lineHeight;
    private log;
    private logError;
    generateThreadPDF(thread: MessageThread, outputPath: string, attachmentPaths?: MessageAttachmentPaths): Promise<void>;
    private addMessageBubble;
    private wrapText;
    private drawRoundedRect;
    generateCombinedPDF(threads: MessageThread[], outputPath: string, attachmentPaths?: MessageAttachmentPaths): Promise<void>;
}
