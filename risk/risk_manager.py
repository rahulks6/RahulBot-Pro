"""
============================================================
RahulBot Pro v10
Professional Risk Manager
============================================================
"""


class RiskManager:

    @staticmethod
    def calculate(

        capital,
        risk_percent,
        entry,
        stop_loss

    ):

        # --------------------------------------------------
        # Maximum Risk Amount
        # --------------------------------------------------

        max_risk = capital * (risk_percent / 100)

        # --------------------------------------------------
        # Risk Per Share
        # --------------------------------------------------

        risk_per_share = abs(entry - stop_loss)

        if risk_per_share <= 0:

            raise Exception("Invalid Stop Loss.")

        # --------------------------------------------------
        # Quantity Based On Risk
        # --------------------------------------------------

        risk_quantity = int(max_risk / risk_per_share)

        # --------------------------------------------------
        # Quantity Based On Capital
        # --------------------------------------------------

        capital_quantity = int(capital / entry)

        # --------------------------------------------------
        # Final Quantity
        # --------------------------------------------------

        quantity = min(

            risk_quantity,

            capital_quantity

        )

        if quantity <= 0:

            quantity = 1

        # --------------------------------------------------
        # Investment
        # --------------------------------------------------

        investment = quantity * entry

        # --------------------------------------------------
        # Target (1:2 RR)
        # --------------------------------------------------

        target = entry + (risk_per_share * 2)

        # --------------------------------------------------
        # Actual Risk
        # --------------------------------------------------

        actual_risk = quantity * risk_per_share

        reward = quantity * (target - entry)

        rr_ratio = reward / actual_risk if actual_risk else 0

        return {

            "capital": capital,

            "risk_percent": risk_percent,

            "risk_amount": round(max_risk, 2),

            "entry": round(entry, 2),

            "stop_loss": round(stop_loss, 2),

            "target": round(target, 2),

            "risk_per_share": round(risk_per_share, 2),

            "quantity": quantity,

            "investment": round(investment, 2),

            "actual_risk": round(actual_risk, 2),

            "reward": round(reward, 2),

            "risk_reward": round(rr_ratio, 2)

        }