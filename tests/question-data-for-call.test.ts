// Mobile fork: questionDataForCall moved out of the desktop dock so the phone
// dock builds the same QuestionData (same shuffle, same grading inputs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswer, questionDataForCall } from "../src/core/question-core.ts";

const probeInput = {
	question: "Which one is a photon?",
	options: [{ label: "A wave" }, { label: "A particle" }, { label: "A quantum of light" }, { label: "A field" }],
	correctAnswer: "A quantum of light",
	explanation: "Light comes in quanta.",
};

test("probe: deterministic shuffle per toolCallId, correct index follows the shuffle", () => {
	const a = questionDataForCall("probe", "call_1", probeInput);
	const b = questionDataForCall("probe", "call_1", probeInput);
	assert.deepEqual(a.options, b.options, "same call, same order");
	assert.equal(a.kind, "quiz");
	assert.equal(a.mode, "single-select");
	const correctLabel = a.options[a.correctIndices![0]! - 1]!.label;
	assert.equal(correctLabel, "A quantum of light");
	const answer = buildAnswer(a, { values: [a.options[a.correctIndices![0]! - 1]!.value], confidence: 70 }, "probe");
	assert.equal(answer.correct, true);
	assert.equal(answer.confidence, 70);
	assert.equal(answer.tool, "probe");
});

test("a correctAnswer that matches no option reports an error and grades nothing correct", () => {
	const errors: string[] = [];
	const q = questionDataForCall("quiz", "call_2", { ...probeInput, correctAnswer: "nope" }, (m) => errors.push(m));
	assert.equal(errors.length, 1);
	assert.deepEqual(q.correctIndices, []);
});

test("recall/explain keeps the commitment and uses text mode", () => {
	const q = questionDataForCall("recall", "call_3", { question: "State E = hf in words.", correctAnswer: "Energy equals Planck's constant times frequency." });
	assert.equal(q.kind, "explain");
	assert.equal(q.mode, "text");
	assert.equal(q.committedAnswer, "Energy equals Planck's constant times frequency.");
	assert.equal(buildAnswer(q, { text: "energy is h times f" }, "recall").committed, q.committedAnswer);
});

test("ask with options is select mode in author order; multiSelect switches mode", () => {
	const input = { question: "Pick topics", options: [{ label: "Optics" }, { label: "Atoms" }] };
	const single = questionDataForCall("ask_user_question", "call_4", input);
	assert.equal(single.mode, "single-select");
	assert.deepEqual(single.options.map((o) => o.label), ["Optics", "Atoms"]);
	assert.equal(questionDataForCall("ask_user_question", "call_4", { ...input, multiSelect: true }).mode, "multi-select");
	assert.equal(questionDataForCall("ask_user_question", "call_5", { question: "Why?" }).mode, "text");
});
