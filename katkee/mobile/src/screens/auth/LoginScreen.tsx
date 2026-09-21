import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { AuthStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

export function LoginScreen({ navigation }: Props): React.JSX.Element {
  const { login, error, fieldErrors, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      await login({ email, password });
    } catch {
      // error/fieldErrors surfaced via useAuth() state below
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={[typography.displayLarge, styles.brand]}>KATKEE</Text>
      <Text style={[typography.body, styles.subtitle]}>Discover people you want to see again.</Text>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textDisabled}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={(t) => {
          setEmail(t);
          clearError();
        }}
      />
      {fieldErrors?.email ? <Text style={styles.fieldError}>{fieldErrors.email}</Text> : null}

      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textDisabled}
        secureTextEntry
        value={password}
        onChangeText={(t) => {
          setPassword(t);
          clearError();
        }}
      />
      {fieldErrors?.password ? <Text style={styles.fieldError}>{fieldErrors.password}</Text> : null}

      <Pressable
        style={[styles.primaryButton, submitting && styles.primaryButtonDisabled]}
        disabled={submitting || !email || !password}
        onPress={onSubmit}
      >
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryLabel}>Log in</Text>}
      </Pressable>

      <Pressable style={styles.linkButton} onPress={() => navigation.navigate("Signup")}>
        <Text style={typography.body}>
          New to Katkee? <Text style={styles.linkAccent}>Create an account</Text>
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  brand: { textAlign: "center", color: colors.accent, letterSpacing: 2 },
  subtitle: { textAlign: "center", color: colors.textSecondary, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
  },
  fieldError: { color: colors.danger, fontSize: 12, marginTop: -spacing.xs },
  errorBanner: {
    backgroundColor: "rgba(228,72,60,0.12)",
    color: colors.danger,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    alignItems: "center",
    marginTop: spacing.md,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryLabel: { color: colors.onAccent, fontWeight: "700", fontSize: 16 },
  linkButton: { marginTop: spacing.lg, alignItems: "center" },
  linkAccent: { color: colors.accent, fontWeight: "600" },
});
