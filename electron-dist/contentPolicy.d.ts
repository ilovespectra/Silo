export declare function containsExplicitTerms(value: string): boolean;
export declare function fileTextLooksExplicit(file: {
    name: string;
    path: string;
}, metadata?: {
    displayName?: string;
    keywords?: string[];
}): boolean;
export declare const NSFW_VISUAL_PROMPT = "explicit adult sexual content, pornography, exposed genitals, graphic nudity, erotic fetish imagery";
export declare const SAFE_VISUAL_PROMPT = "safe non-explicit everyday image, fully clothed people, landscape, object, family-friendly artwork";
