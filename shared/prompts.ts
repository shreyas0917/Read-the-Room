// Question bank. Every prompt is a 1–10 rating with labelled ends.
// Prompts are playful by design: nothing about health, money, relationships,
// identity or anything a player could be embarrassed to have attributed.
// `onRecord` marks prompts light enough to be used by the opt-in
// "Who said it?" Echo Round (players see a badge before answering them).

export interface Prompt {
  id: string;
  text: string;
  low: string;
  high: string;
  onRecord?: boolean;
}

export const PROMPTS: readonly Prompt[] = [
  { id: "p01", text: "How much do you trust a gas-station sushi roll?", low: "Never", high: "With my life", onRecord: true },
  { id: "p02", text: "How chaotic is your phone's home screen right now?", low: "Museum", high: "Crime scene", onRecord: true },
  { id: "p03", text: "Rate pineapple on pizza.", low: "Illegal", high: "Perfection", onRecord: true },
  { id: "p04", text: "How likely are you to survive the first week of a zombie outbreak?", low: "Day one", high: "Final boss", onRecord: true },
  { id: "p05", text: "How loud is your sneeze?", low: "Mouse", high: "Thunder", onRecord: true },
  { id: "p06", text: "How good would you be as a reality-TV contestant?", low: "Out first", high: "Winner", onRecord: true },
  { id: "p07", text: "How many browser tabs is \"too many\"?", low: "Five is wild", high: "No such thing", onRecord: true },
  { id: "p08", text: "How competitive are you at board games?", low: "Just vibes", high: "Flips tables", onRecord: true },
  { id: "p09", text: "How confident are you parallel parking with people watching?", low: "I'll walk", high: "One move", onRecord: true },
  { id: "p10", text: "How much do you enjoy karaoke?", low: "Hide me", high: "Mic is mine", onRecord: true },
  { id: "p11", text: "How spicy can you actually handle?", low: "Black pepper", high: "Ghost pepper", onRecord: true },
  { id: "p12", text: "How good are you at keeping a plant alive?", low: "Plant killer", high: "Jungle", onRecord: true },
  { id: "p13", text: "How likely are you to reply to a text within five minutes?", low: "Next week", high: "Instantly", onRecord: true },
  { id: "p14", text: "How much do you love surprise parties?", low: "Nightmare", high: "Every day", onRecord: true },
  { id: "p15", text: "How long could you go without your phone, happily?", low: "Minutes", high: "Weeks", onRecord: true },
  { id: "p16", text: "How strong is your sense of direction?", low: "Lost at home", high: "Human GPS", onRecord: true },
  { id: "p17", text: "How much do you enjoy rainy days?", low: "Gloom", high: "Best weather", onRecord: true },
  { id: "p18", text: "How likely are you to cry at an animated movie?", low: "Stone", high: "Every time", onRecord: true },
  { id: "p19", text: "How much of a morning person are you?", low: "Do not speak", high: "Sunrise club", onRecord: true },
  { id: "p20", text: "How good is your handwriting?", low: "Hieroglyphs", high: "Calligraphy", onRecord: true },
  { id: "p21", text: "How likely are you to read the terms and conditions?", low: "Never", high: "Every word", onRecord: true },
  { id: "p22", text: "How much do you trust your own cooking?", low: "Order in", high: "Chef", onRecord: true },
  { id: "p23", text: "How ready are you to go to space tomorrow?", low: "No thanks", high: "Pack my bag", onRecord: true },
  { id: "p24", text: "How dramatic are you when you have a mild cold?", low: "Fine", high: "Write my will", onRecord: true },
  { id: "p25", text: "How good are you at remembering names?", low: "Hey… you", high: "Never forget", onRecord: true },
  { id: "p26", text: "Rate the idea of a four-day week of only breakfast food.", low: "Please no", high: "Sign me up", onRecord: true },
  { id: "p27", text: "How likely are you to start a group-chat argument about something trivial?", low: "Peacekeeper", high: "Instigator", onRecord: true },
  { id: "p28", text: "How good would you be at a silent retreat?", low: "Ten seconds", high: "Monk mode", onRecord: true },
  { id: "p29", text: "How many snooze-button presses is normal?", low: "Zero", high: "Double digits", onRecord: true },
  { id: "p30", text: "How much do you enjoy assembling flat-pack furniture?", low: "Torture", high: "Therapy", onRecord: true },
  { id: "p31", text: "How likely are you to befriend a stranger's dog in under a minute?", low: "Unlikely", high: "Already did", onRecord: true },
  { id: "p32", text: "How good are you at keeping a secret?", low: "Leaky", high: "Vault", onRecord: true },
  { id: "p33", text: "Rate cereal as a dinner option.", low: "Tragic", high: "Elite", onRecord: true },
  { id: "p34", text: "How likely are you to win a staring contest against a cat?", low: "Hopeless", high: "Unbeatable", onRecord: true },
  { id: "p35", text: "How much do you plan your vacations?", low: "Wing it", high: "Spreadsheet", onRecord: true },
  { id: "p36", text: "How good is your poker face?", low: "Open book", high: "Unreadable", onRecord: true },
  { id: "p37", text: "How likely are you to sing in the shower?", low: "Silence", high: "Full concert", onRecord: true },
  { id: "p38", text: "How much would you enjoy being a lighthouse keeper for a year?", low: "Misery", high: "Dream job", onRecord: true },
  { id: "p39", text: "How good are you at assembling a playlist for a road trip?", low: "Radio is fine", high: "DJ legend", onRecord: true },
  { id: "p40", text: "How likely are you to return a shopping cart every single time?", low: "Rarely", high: "Always", onRecord: true },
  { id: "p41", text: "How much do you enjoy horror movies?", low: "Hide", high: "More blood", onRecord: true },
  { id: "p42", text: "How likely are you to finish a 1000-piece puzzle?", low: "Box stays shut", high: "Framed it", onRecord: true },
  { id: "p43", text: "How good would you be at improv comedy?", low: "Frozen", high: "Natural", onRecord: true },
  { id: "p44", text: "How much do you care about matching socks?", low: "Never", high: "Always", onRecord: true },
  { id: "p45", text: "How likely are you to try a dish you can't pronounce?", low: "Safe order", high: "Bring it", onRecord: true },
  { id: "p46", text: "How fast do you walk compared to most people?", low: "Stroll", high: "Speed walker", onRecord: true },
  { id: "p47", text: "How well could you survive a weekend with no internet?", low: "Panic", high: "Bliss", onRecord: true },
  { id: "p48", text: "How likely are you to talk to your pet (or a plant) like a person?", low: "Never", high: "Full chats", onRecord: true },
  { id: "p49", text: "How good are you at choosing a restaurant for a group?", low: "Anywhere?", high: "Decisive", onRecord: true },
  { id: "p50", text: "How much do you enjoy a really long walk?", low: "Pass", high: "All day", onRecord: true },
  { id: "p51", text: "Rate the movie-theater popcorn experience.", low: "Skip", high: "The point", onRecord: true },
  { id: "p52", text: "How likely are you to win a dance-off at a wedding?", low: "No chance", high: "Champion", onRecord: true },
  { id: "p53", text: "How messy is your bag or backpack right now?", low: "Organised", high: "Black hole", onRecord: true },
  { id: "p54", text: "How good are you at guessing the ending of a movie?", low: "Always shocked", high: "Called it", onRecord: true },
  { id: "p55", text: "How much would you enjoy living in a treehouse?", low: "Ground please", high: "Move in today", onRecord: true },
  { id: "p56", text: "How likely are you to laugh at your own joke before the punchline?", low: "Composed", high: "Every time", onRecord: true },
  { id: "p57", text: "How good is your memory for song lyrics?", low: "Mumble", high: "Every word", onRecord: true },
  { id: "p58", text: "How much do you love a theme park roller coaster?", low: "Ground crew", high: "Front row", onRecord: true },
  { id: "p59", text: "How likely are you to bring snacks for everyone?", low: "Just mine", high: "Whole buffet", onRecord: true },
  { id: "p60", text: "How tidy is your desk right now?", low: "Avalanche", high: "Spotless", onRecord: true },
];

const BY_ID = new Map(PROMPTS.map((p) => [p.id, p]));

export function getPrompt(id: string): Prompt {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`Unknown prompt ${id}`);
  return p;
}
