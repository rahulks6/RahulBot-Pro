import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { AuthStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";

type Props = NativeStackScreenProps<AuthStackParamList, "Signup">;

export function SignupScreen({ navigation }: Props): React.JSX.Element {
  const { signup, error, fieldErrors, clearError } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      await signup({ displayName, username, email, password });
    } catch {
      // error/fieldErrors surfaced via useAuth() state below
    } finally {
      setSubmitting(false);
    }
  };

  const field = (
    key: string,
    props: {
      placeholder: string;
      value: string;
      onChangeText: (t: string) => void;
      secureTextEntry?: boolean;
      autoCapitalize?: "none" | "words";
    },
  ) => (
    <View style={styles.field} key={key}>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textDisabled}
        autoCapitalize={props.autoCapitalize ?? "none"}
        secureTextEntry={props.secureTextEntry}
        value={props.value}
        onChangeText={(t) => {
          props.onChangeText(t);
          clearError();
        }}
        placeholder={props.placeholder}
      />
      {fieldErrors?.[key] ? <Text style={styles.fieldError}>{fieldErrors[key]}</Text> : null}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[typography.title, styles.title]}>Create your account</Text>
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      {field("displayName", { placeholder: "Display name", value: displayName, onChangeText: setDisplayName, autoCapitalize: "words" })}
      {field("username", { placeholder: "Username", value: username, onChangeText: (t) => setUsername(t.toLowerCase()) })}
      {field("email", { placeholder: "Email", value: email, onChangeText: setEmail })}
      {field("password", { placeholder: "Password", value: password, onChangeText: setPassword, secureTextEntry: true })}

      <Pressable
        style={[styles.primaryButton, submitting && styles.primaryButtonDisabled]}
        disabled={submitting || !displayName || !username || !email || !password}
        onPress={onSubmit}
      >
        {submitting ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.primaryLabel}>Sign up</Text>
        )}
      </Pressable>

      <Pressable style={styles.linkButton} onPress={() => navigation.navigate("Login")}>
        <Text style={typography.body}>
          Already have an account? <Text style={styles.linkAccent}>Log in</Text>
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  title: { textAlign: "center", marginBottom: spacing.md },
  field: { gap: spacing.xs },
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
  fieldError: { color: colors.danger, fontSize: 12 },
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
