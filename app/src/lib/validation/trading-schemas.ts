import { z } from "zod";

// Shared refinements
const positiveDecimal = (min: number = 0.001, max: number = 100_000) =>
  z
    .string()
    .min(1, "Amount required")
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: "Must be a positive number",
    })
    .refine(
      (val) => {
        const num = Number(val);
        return num >= min && num <= max;
      },
      {
        message: `Amount must be between ${min} and ${max.toLocaleString()}`,
      }
    );

const slippageField = z
  .number()
  .min(0.1, "Slippage too low")
  .max(10, "Slippage too high");

// Buy tokens on bonding curve
export const buyFormSchema = z.object({
  xyzAmount: positiveDecimal(0.001, 100_000_000_000),
  slippage: slippageField,
});
export type BuyFormValues = z.infer<typeof buyFormSchema>;

// Sell tokens back to bonding curve
export const sellFormSchema = z.object({
  tokenAmount: positiveDecimal(0.000001, 1_000_000_000_000),
  slippage: slippageField,
});
export type SellFormValues = z.infer<typeof sellFormSchema>;

// Swap on AMM pool
export const swapFormSchema = z.object({
  offerAmount: positiveDecimal(0.001, 100_000_000_000),
  slippage: slippageField,
});
export type SwapFormValues = z.infer<typeof swapFormSchema>;

// Create new token launch
export const createTokenSchema = z.object({
  name: z
    .string()
    .min(1, "Name required")
    .max(32, "Name too long (max 32 characters)"),
  symbol: z
    .string()
    .min(1, "Symbol required")
    .max(10, "Symbol too long (max 10 characters)")
    .regex(/^[A-Z0-9]+$/, "Symbol must be uppercase letters and numbers only"),
  image: z
    .string()
    .min(1, "Image URL required")
    .url("Enter a valid image URL"),
  description: z
    .string()
    .max(500, "Description too long (max 500 characters)")
    .optional()
    .or(z.literal("")),
  socialLinks: z.string(),
});
export type CreateTokenFormValues = z.infer<typeof createTokenSchema>;
