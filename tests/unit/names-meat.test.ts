import { describe, expect, it } from "vitest";
import { namesMeat } from "@/contracts/menu-prechecks";

// Boston audit, 27 Nov 2026: meat and fish dishes were showing among restaurant meals because their names used
// words the check did not know. A restaurant's own vegan or vegetarian label still wins (mealFit), and a plant word
// beside the meat word means a plant-based version.
describe("names meat or fish", () => {
  it("catches the dishes the audit found", () => {
    for (const d of ["6 oz. FILET MIGNON", "California BLT", "Al Pastor", "Birria Taco", "BABY BACK RIBS", "FRIED CALAMARI", "SPICY YELLOWTAIL maki", "TORO + UNI temaki",
      "Meatball Parmigiana", "Pizza Slice (Pepperoni)", "Seafood Plate", "24-HOUR TONKOTSU MISO RAMEN NOODLE SOUP", "Stuffed Grape Leaves (Meat)", "Veal"])
      expect(namesMeat(d), d).toBe(true);
  });
  it("leaves vegetarian dishes and plant-based versions alone", () => {
    for (const d of ["Malai Kofta", "Paneer Tikka Masala", "Goat Cheese (Fresh Salads)", "Hand-Pulled Noodles", "Vegan meatballs", "Tofu Poke Bowl", "Beyond Steak Filet",
      "Vegetable Rainbow", "Unicorn Smoothie", "Universe Bowl", "Codfather Veggie Wrap", "Sea Salt Fries"])
      expect(namesMeat(d), d).toBe(false);
  });
});
