import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../../theme";

const FAQS: Array<{ question: string; answer: string }> = [
  {
    question: "Who can see my Stories?",
    answer:
      "Public accounts: anyone. Private accounts: only followers you've approved. You can change this any time in Settings > Privacy.",
  },
  {
    question: "How long does a Story last?",
    answer: "24 hours from when you publish it, unless you add it to a Highlight — Highlights never expire.",
  },
  {
    question: "How do I stop getting a certain kind of notification?",
    answer: "Settings > Notifications lets you turn off likes, comments, follows, or mentions independently.",
  },
  {
    question: "Can I get my account back after deleting it?",
    answer: "No — account deletion in Settings is permanent and can't be undone.",
  },
];

/** Real, static Help content — no support ticket system exists in this app, so this is FAQ-only rather than a fake "Contact us" that goes nowhere. */
export function HelpScreen(): React.JSX.Element {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {FAQS.map((faq) => (
        <View key={faq.question} style={styles.item}>
          <Text style={[typography.bodyStrong, styles.question]}>{faq.question}</Text>
          <Text style={[typography.body, styles.answer]}>{faq.answer}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.lg },
  item: { gap: spacing.xs },
  question: {},
  answer: { color: colors.textSecondary },
});
