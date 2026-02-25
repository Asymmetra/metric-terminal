"""Trader key identification and PDA derivation for Phoenix."""

from __future__ import annotations

from solders.pubkey import Pubkey

ETERNAL_PROGRAM_ID = Pubkey.from_string("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih")


class TraderKey:
    """Identifies a trader on Phoenix by authority pubkey and PDA indices.

    Parameters
    ----------
    authority:
        The trader's wallet public key.
    pda_index:
        PDA index (0-255), default 0.
    subaccount_index:
        Subaccount index (0 for cross-margin main account), default 0.
    """

    def __init__(
        self,
        authority: Pubkey,
        pda_index: int = 0,
        subaccount_index: int = 0,
    ) -> None:
        self.authority = authority
        self.pda_index = pda_index
        self.subaccount_index = subaccount_index

    def pda(self) -> Pubkey:
        """Derive the trader PDA address.

        Seeds: ``["trader", authority, [pda_index, subaccount_index]]``
        """
        pda_schema = bytes([self.pda_index, self.subaccount_index])
        pda, _ = Pubkey.find_program_address(
            [b"trader", bytes(self.authority), pda_schema],
            ETERNAL_PROGRAM_ID,
        )
        return pda

    @staticmethod
    def derive_pda(
        authority: Pubkey,
        pda_index: int = 0,
        subaccount_index: int = 0,
    ) -> Pubkey:
        """Derive a trader PDA without constructing a TraderKey instance."""
        pda_schema = bytes([pda_index, subaccount_index])
        pda, _ = Pubkey.find_program_address(
            [b"trader", bytes(authority), pda_schema],
            ETERNAL_PROGRAM_ID,
        )
        return pda
